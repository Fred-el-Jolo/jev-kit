/**
 * The ONLY file that knows Jev's wire format. Everything that maps to or from the Jev API lives
 * here; the rest of jev-kit is Jev-shape-agnostic. See docs/JEV-MAPPING.md for the table of
 * every difference and what to change when the API evolves.
 */
import {
  APIUserAbortError,
  AuthenticationError,
  BadRequestError,
  PermissionDeniedError,
  UnprocessableEntityError,
  type SystemOneRequest,
  type SystemOneResult,
} from "@typesafe-ai/sdk";
import { JevKitError, type Answer, type AskRequest, type Questions, type State, type Usage } from "./types.ts";

// ── Request: jev-kit → Jev ────────────────────────────────────────────────────────────────────

/**
 * Local checks before sending, so bad requests fail fast (exit 2) without a network call.
 * Deliberately shallow: only the limits the docs state (choice ≤ 255 options, score 2–10 levels)
 * and the three known types. Anything subtler is left to Jev, whose 400/422 become `invalid_input`.
 * NEW QUESTION TYPE: add a `case` here.
 */
export function validateQuestions(q: unknown, where = "request"): asserts q is Questions {
  const bad = (m: string): never => {
    throw new JevKitError("invalid_input", `${where}: ${m}`);
  };
  if (!q || typeof q !== "object" || Array.isArray(q)) return bad('"questions" must be an object map');
  const entries = Object.entries(q);
  if (entries.length === 0) return bad('"questions" is empty');
  for (const [id, question] of entries as [string, any][]) {
    if (!question || typeof question !== "object") return bad(`question "${id}" must be an object`);
    switch (question.type) {
      case "noul":
        break;
      case "choice": {
        const c = question.criteria;
        if (!c || typeof c !== "object" || Array.isArray(c)) return bad(`choice "${id}": criteria must be an object`);
        const n = Object.keys(c).length;
        if (n < 1 || n > 255) return bad(`choice "${id}": needs 1–255 options (got ${n})`);
        break;
      }
      case "score": {
        const c = question.criteria;
        if (!Array.isArray(c) || c.length < 2 || c.length > 10) return bad(`score "${id}": criteria must be an array of 2–10 levels`);
        break;
      }
      default:
        return bad(`question "${id}": unknown type "${question.type}" (noul | choice | score)`);
    }
  }
}


/** `state` must be text or JSON (string | object | array): Jev is text-only. */
export function assertState(v: unknown): State {
  if (typeof v === "string" || (v !== null && typeof v === "object")) return v as State;
  throw new JevKitError("invalid_input", `state must be a string, object or array (got ${v === null ? "null" : typeof v})`);
}

/**
 * jev-kit request → official Jev request body (via the SDK).
 * Sent verbatim: `state`, `questions`. Optional: `model` (omitted → SDK default `jev-latest`).
 * NOT sent: `consumer`, `preset`, `signal`, `timeoutMs` (jev-kit-only; see docs/JEV-MAPPING.md).
 */
export function toJevRequest(req: AskRequest, defaultModel: string | undefined): SystemOneRequest {
  const model = req.model ?? defaultModel;
  return { state: req.state, questions: req.questions, ...(model && { model }) };
}

// ── Response: Jev → jev-kit ───────────────────────────────────────────────────────────────────

/**
 * Jev answers verbatim, with ONE rename: the value field named after the type
 * (`noul` | `choice` | `score`) becomes `answer`. Every other field (`type`, `probabilities`,
 * `confidence`, `legend`, and anything Jev adds later) is copied untouched. Generic on purpose:
 * a new answer type whose value field is named after its `type` works with no change here.
 */
export function fromJevAnswers(raw: Record<string, any>): Record<string, Answer> {
  const out: Record<string, Answer> = {};
  for (const [id, a] of Object.entries(raw)) {
    const { [a.type]: value, ...rest } = a;
    out[id] = { type: a.type, answer: value, ...rest };
  }
  return out;
}

/** Response fields jev-kit surfaces: `model`, `answers` (renamed as above), `usage`. */
export function fromJevResponse(res: SystemOneResult<any>): { model: string; answers: Record<string, Answer>; usage: Usage } {
  return {
    model: res.model,
    answers: fromJevAnswers(res.answers as Record<string, any>),
    usage: { input_tokens: res.usage.input_tokens, output_tokens: res.usage.output_tokens },
  };
}

// ── Errors: Jev/SDK → jev-kit ─────────────────────────────────────────────────────────────────

export type Classified =
  | { kind: "invalid_input"; detail: string } // 400 / 422: the request is wrong; thrown, no breaker
  | { kind: "auth"; detail: string } //          401 / 403: trips the consumer's breaker at once
  | { kind: "error"; detail: string }; //        429 (after SDK retries), 5xx/529, timeout, connection

/** Returns null for a user abort, which the caller must rethrow. */
export function classifyError(e: unknown): Classified | null {
  if (e instanceof APIUserAbortError) return null;
  const detail = (e as Error).message;
  if (e instanceof UnprocessableEntityError || e instanceof BadRequestError) return { kind: "invalid_input", detail };
  if (e instanceof AuthenticationError || e instanceof PermissionDeniedError) return { kind: "auth", detail };
  return { kind: "error", detail };
}

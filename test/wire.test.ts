/**
 * Contract tests for core/wire.ts. The fixtures are copied VERBATIM from the official API
 * reference (https://docs.typesafe.ai/api.md). When the API changes: update the fixtures from
 * the docs first, watch what fails, then adapt core/wire.ts. See docs/JEV-MAPPING.md.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { classifyError, fromJevAnswers, fromJevResponse, toJevRequest, validateQuestions } from "../core/wire.ts";
import { JevKitError } from "../core/types.ts";

// api.md "Noul answer" / "Choice answer" / "Score answer" example responses
const NOUL = { model: "jev-1.13.0", answers: { is_urgent: { type: "noul", noul: 0.95 } }, usage: { input_tokens: 307, output_tokens: 20 } };
const CHOICE = {
  model: "jev-1.13.0",
  answers: { department: { type: "choice", choice: "billing", probabilities: { billing: 0.88, technical: 0.12, sales: 0.0 }, confidence: 0.81 } },
  usage: { input_tokens: 318, output_tokens: 34 },
};
const SCORE = {
  model: "jev-1.13.0",
  answers: { frustration: { type: "score", score: 1.05, legend: { 0: "Calm", 1: "Frustrated", 2: "Very angry" }, probabilities: { 0: 0.0, 1: 0.95, 2: 0.05 }, confidence: 0.92 } },
  usage: { input_tokens: 304, output_tokens: 18 },
};

describe("Jev → jev-kit (fromJevResponse)", () => {
  it("noul: `noul` → `answer`, no confidence invented", () => {
    assert.deepEqual(fromJevResponse(NOUL as any), {
      model: "jev-1.13.0",
      answers: { is_urgent: { type: "noul", answer: 0.95 } },
      usage: { input_tokens: 307, output_tokens: 20 },
    });
  });
  it("choice: `choice` → `answer`; probabilities and confidence untouched", () => {
    assert.deepEqual(fromJevResponse(CHOICE as any).answers, {
      department: { type: "choice", answer: "billing", probabilities: { billing: 0.88, technical: 0.12, sales: 0 }, confidence: 0.81 },
    });
  });
  it("score: `score` → `answer`; legend, probabilities, confidence untouched", () => {
    assert.deepEqual(fromJevResponse(SCORE as any).answers, {
      frustration: { type: "score", answer: 1.05, legend: { 0: "Calm", 1: "Frustrated", 2: "Very angry" }, probabilities: { 0: 0, 1: 0.95, 2: 0.05 }, confidence: 0.92 },
    });
  });
  it("forward-compatible: unknown extra fields and a new type named like its value field pass through", () => {
    const out = fromJevAnswers({
      a: { type: "choice", choice: "x", probabilities: { x: 1 }, confidence: 1, rationale: "new field" },
      b: { type: "rank", rank: ["p", "q"], confidence: 0.5 },
    });
    assert.deepEqual(out.a, { type: "choice", answer: "x", probabilities: { x: 1 }, confidence: 1, rationale: "new field" });
    assert.deepEqual(out.b, { type: "rank", answer: ["p", "q"], confidence: 0.5 });
  });
});

describe("jev-kit → Jev (toJevRequest)", () => {
  const questions = { q: { type: "noul", instructions: "?" } } as const;
  it("sends state + questions verbatim; jev-kit-only fields never reach Jev", () => {
    const body = toJevRequest({ state: "s", questions, consumer: "isa", preset: "p@1", timeoutMs: 5 } as any, undefined);
    assert.deepEqual(body, { state: "s", questions });
  });
  it("model: request > config default > omitted", () => {
    assert.equal(toJevRequest({ state: "s", questions, model: "jev-1.13.0" } as any, "cfg").model, "jev-1.13.0");
    assert.equal(toJevRequest({ state: "s", questions } as any, "cfg").model, "cfg");
    assert.equal("model" in toJevRequest({ state: "s", questions } as any, undefined), false);
  });
});

describe("validateQuestions (only documented limits)", () => {
  const bad = (q: unknown) => assert.throws(() => validateQuestions(q), (e: JevKitError) => e.code === "invalid_input");
  it("accepts the official examples", () => {
    validateQuestions({ u: { type: "noul", instructions: "?", criteria: { true: "a", false: "b" } } });
    validateQuestions({ d: { type: "choice", instructions: "?", criteria: { a: "x", b: null } } });
    validateQuestions({ f: { type: "score", instructions: "?", criteria: ["Calm", "Angry"] } });
  });
  it("rejects: empty map, unknown type, empty choice, choice > 255, score < 2 or > 10 levels", () => {
    bad({});
    bad({ q: { type: "wat" } });
    bad({ q: { type: "choice", criteria: {} } });
    bad({ q: { type: "choice", criteria: Object.fromEntries(Array.from({ length: 256 }, (_, i) => [`o${i}`, null])) } });
    bad({ q: { type: "score", criteria: ["only one"] } });
    bad({ q: { type: "score", criteria: Array.from({ length: 11 }, () => "l") } });
  });
});

describe("classifyError", () => {
  it("maps SDK errors: 400/422 → invalid_input, 401/403 → auth, anything else → error, abort → null", async () => {
    const sdk = await import("@typesafe-ai/sdk");
    const h = new Headers();
    assert.equal(classifyError(sdk.APIError.fromResponse(422, {}, h))?.kind, "invalid_input");
    assert.equal(classifyError(sdk.APIError.fromResponse(400, {}, h))?.kind, "invalid_input");
    assert.equal(classifyError(sdk.APIError.fromResponse(401, {}, h))?.kind, "auth");
    assert.equal(classifyError(sdk.APIError.fromResponse(403, {}, h))?.kind, "auth");
    assert.equal(classifyError(sdk.APIError.fromResponse(429, {}, h))?.kind, "error");
    assert.equal(classifyError(sdk.APIError.fromResponse(529, {}, h))?.kind, "error");
    assert.equal(classifyError(new sdk.APIConnectionError("down"))?.kind, "error");
    assert.equal(classifyError(new sdk.APIUserAbortError()), null);
  });

  it("credit classification: 402, or a credit-worded error whatever its status → credit", async () => {
    const sdk = await import("@typesafe-ai/sdk");
    const h = new Headers();
    assert.equal(classifyError(sdk.APIError.fromResponse(402, {}, h))?.kind, "credit");
    assert.equal(classifyError(sdk.APIError.fromResponse(403, { error: "Insufficient credit balance" }, h))?.kind, "credit");
    assert.equal(classifyError(sdk.APIError.fromResponse(429, { error: "credit exhausted" }, h))?.kind, "credit");
  });
});

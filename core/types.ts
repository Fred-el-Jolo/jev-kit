import type { Question, Questions } from "@typesafe-ai/sdk";

export type { Question, Questions };

export type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

/** Jev takes text: a string, or JSON object / array. */
export type State = string | Json[] | { [key: string]: Json };

export type UnavailableReason =
  | "disabled" // switched off (manually or JEV_KIT=off)
  | "tripped" // breaker open after failures / latency
  | "budget" // token or request cap reached
  | "error" // the call failed (5xx, timeout, connection, sustained 429)
  | "auth" // key rejected (401/403)
  | "no_key"; // no API key resolved for this consumer

export interface Unavailable {
  reason: UnavailableReason;
  detail: string;
}

/**
 * One answer, exactly as Jev returns it except for one rename: the value field named after the
 * type (`noul` | `choice` | `score`) is called `answer`. Nothing is added or dropped, so fields
 * absent in the API are absent here (noul has no `confidence`).
 */
export interface Answer {
  type: "noul" | "choice" | "score";
  /** noul: P(yes) · choice: chosen option · score: probability-weighted level */
  answer: number | string;
  probabilities?: Record<string, number>;
  confidence?: number;
  /** score only: level index → description */
  legend?: Record<string, unknown>;
}

export interface Usage {
  input_tokens: number;
  output_tokens: number;
}

/** Jev served the call. */
export interface Served {
  ok: true;
  consumer: string;
  /** Versioned model id that answered (e.g. "jev-1.13.0"), as reported by Jev. */
  model: string;
  answers: Record<string, Answer>;
  usage: Usage;
}

/**
 * Jev did not serve the call. Not an error: the caller decides what to do instead.
 * jev-kit never invents answers.
 */
export interface NotServed {
  ok: false;
  consumer: string;
  unavailable: Unavailable;
}

export type Result = Served | NotServed;

/** Local, free answer to "would a call be served right now?" */
export type Availability =
  | { ok: true; consumer: string; note?: string }
  | { ok: false; consumer: string; unavailable: Unavailable };

export interface Preset {
  name: string;
  version: number | string;
  description?: string;
  consumer?: string;
  /** Jev model or alias (e.g. "jev-1.13.0"). Absent: config.json `model`, then the SDK default. */
  model?: string;
  /** How to build `state` from the caller's input. Absent: the input is the state. */
  state?: { template: string };
  questions: Questions;
  path: string;
}

export interface AskRequest {
  state: State;
  questions: Questions;
  consumer?: string;
  /** Label only (recorded in the ledger). */
  preset?: string;
  model?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}

/** Only caller bugs are thrown. Unavailability is a returned `NotServed`. */
export type ErrorCode = "invalid_input";

/** CLI exit codes. Unavailability maps by reason; see `exitCodeFor`. */
export const EXIT_CODES = { invalid_input: 2, auth: 3, unavailable: 4, budget: 5 } as const;

export function exitCodeFor(u: Unavailable): number {
  if (u.reason === "budget") return EXIT_CODES.budget;
  if (u.reason === "auth" || u.reason === "no_key") return EXIT_CODES.auth;
  return EXIT_CODES.unavailable;
}

export class JevKitError extends Error {
  code: ErrorCode;
  constructor(code: ErrorCode, message: string) {
    super(message);
    this.name = "JevKitError";
    this.code = code;
  }
}

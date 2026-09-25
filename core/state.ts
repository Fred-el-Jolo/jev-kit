import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { envSuffix, stateDir } from "./config.ts";

export interface BreakerState {
  failures: number;
  /** Set while tripped (ms epoch). */
  trippedAt?: number;
  reason?: string;
  /** Set when a half-open probe has been claimed (ms epoch). */
  probeAt?: number;
  /** Trips immediately on auth failure; recorded so `status` can say why. */
  auth?: boolean;
}

export interface Scope {
  /** Manual switch. Absent = on. */
  mode?: "off";
  /** ms epoch; the manual `off` lapses after this. */
  until?: number;
  breaker?: BreakerState;
}

export interface StateFile {
  global: Scope;
  consumers: Record<string, Scope>;
}

export type Mode = "on" | "off" | "tripped";

export interface Effective {
  mode: Mode;
  source: "env" | "file" | "breaker" | "default";
  until?: number;
  detail?: string;
}

/** A probe claimed longer ago than this is considered lost (the prober died). */
export const PROBE_TIMEOUT_MS = 60_000;

export function stateFilePath(env = process.env): string {
  return join(stateDir(env), "state.json");
}

export function readState(env = process.env): StateFile {
  try {
    const s = JSON.parse(readFileSync(stateFilePath(env), "utf8"));
    // null prototype: a consumer named "constructor" must not resolve to Object.prototype members
    return { global: s.global ?? {}, consumers: Object.assign(Object.create(null), s.consumers) };
  } catch {
    // Missing or corrupt state must never break a call: behave as default (on).
    return { global: {}, consumers: Object.create(null) };
  }
}

/** Atomic replace. Concurrent writers are last-write-wins: state is advisory, not a lock. */
export function writeState(s: StateFile, env = process.env): void {
  mkdirSync(stateDir(env), { recursive: true, mode: 0o700 });
  const file = stateFilePath(env);
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(s, null, 2) + "\n", { mode: 0o600 });
  renameSync(tmp, file);
}

/** `consumer` undefined = the global scope. */
export function updateScope(
  consumer: string | undefined,
  fn: (scope: Scope) => Scope | void,
  env = process.env,
): Scope {
  const s = readState(env);
  const cur = consumer === undefined ? s.global : (s.consumers[consumer] ?? {});
  const next = fn(cur) ?? cur;
  if (consumer === undefined) s.global = next;
  else if (Object.keys(next).length === 0) delete s.consumers[consumer];
  else s.consumers[consumer] = next;
  writeState(s, env);
  return next;
}

export function envMode(consumer: string | undefined, env = process.env): "on" | "off" | undefined {
  const raw = consumer === undefined ? env.JEV_KIT : env[`JEV_KIT_${envSuffix(consumer)}`];
  const v = raw?.trim().toLowerCase();
  return v === "on" || v === "off" ? v : undefined;
}

/**
 * Precedence: env > state file > default on.
 * Env `on` overrides a manual `off` but not an open breaker (safety net stays).
 */
export function effective(
  scope: Scope,
  consumer: string | undefined,
  now = Date.now(),
  env = process.env,
): Effective {
  const forced = envMode(consumer, env);
  const name = consumer === undefined ? "JEV_KIT" : `JEV_KIT_${envSuffix(consumer)}`;
  if (forced === "off") return { mode: "off", source: "env", detail: `${name}=off` };
  if (forced !== "on" && scope.mode === "off" && (scope.until === undefined || scope.until > now)) {
    return { mode: "off", source: "file", until: scope.until, detail: "disabled manually" };
  }
  if (scope.breaker?.trippedAt !== undefined) {
    return {
      mode: "tripped",
      source: "breaker",
      detail: scope.breaker.reason ?? `${scope.breaker.failures} consecutive failures`,
    };
  }
  return { mode: "on", source: forced ? "env" : "default" };
}

export function hasProbeWindow(b: BreakerState, cooldownMs: number, now: number): boolean {
  if (b.trippedAt === undefined || now < b.trippedAt + cooldownMs) return false;
  return b.probeAt === undefined || now - b.probeAt > PROBE_TIMEOUT_MS;
}

/** Half-open: at most one caller wins the probe after the cooldown. */
export function claimProbe(consumer: string, cooldownMs: number, now = Date.now(), env = process.env): boolean {
  let won = false;
  updateScope(
    consumer,
    (scope) => {
      const b = scope.breaker;
      if (b && hasProbeWindow(b, cooldownMs, now)) {
        won = true;
        return { ...scope, breaker: { ...b, probeAt: now } };
      }
    },
    env,
  );
  return won;
}

export function recordSuccess(consumer: string, env = process.env): void {
  const s = readState(env);
  const b = s.consumers[consumer]?.breaker;
  if (!b || (b.failures === 0 && b.trippedAt === undefined)) return; // common case: no write
  updateScope(consumer, ({ breaker: _, ...rest }) => rest, env);
}

export function recordFailure(
  consumer: string,
  opts: { threshold: number; reason: string; immediate?: boolean; auth?: boolean },
  now = Date.now(),
  env = process.env,
): { tripped: boolean } {
  let tripped = false;
  updateScope(
    consumer,
    (scope) => {
      const prev = scope.breaker;
      const failures = (prev?.failures ?? 0) + 1;
      // A failed half-open probe re-trips at once; otherwise trip on threshold.
      const trip = opts.immediate || prev?.trippedAt !== undefined || failures >= opts.threshold;
      tripped = trip;
      const breaker: BreakerState = { failures, reason: opts.reason };
      if (opts.auth) breaker.auth = true;
      if (trip) breaker.trippedAt = now;
      return { ...scope, breaker };
    },
    env,
  );
  return { tripped };
}

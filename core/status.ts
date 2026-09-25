import { loadConfig, normalizeConsumer } from "./config.ts";
import { budgetFor, readLedger, summarize } from "./ledger.ts";
import { effective, readState, recordFailure, updateScope, type BreakerState, type Effective } from "./state.ts";

export interface ScopeStatus {
  consumer: string | null;
  effective: Effective;
  breaker?: BreakerState;
  usage?: { tokens24h: number; requestsLastHour: number; tokensPerDay: number | null; requestsPerHour: number | null };
}

export interface Status {
  /** Would a call by each listed consumer be served by Jev right now (ignoring budgets)? */
  scopes: ScopeStatus[];
}

const norm = (c: string | undefined) => (c === undefined ? undefined : normalizeConsumer(c));

/** Global scope plus every consumer that has state, plus any explicitly requested. */
export function status(consumers: string[] = [], env = process.env): Status {
  const now = Date.now();
  const cfg = loadConfig(env);
  const s = readState(env);
  const names = [...new Set([...Object.keys(s.consumers), ...consumers.map((c) => normalizeConsumer(c))])];
  const ledger = readLedger(now - 86_400_000, env);
  const scopes: ScopeStatus[] = [{ consumer: null, effective: effective(s.global, undefined, now, env) }];
  for (const c of names) {
    const scope = s.consumers[c] ?? {};
    const u = summarize(ledger, c, now);
    const b = budgetFor(cfg, c);
    scopes.push({
      consumer: c,
      effective: effective(scope, c, now, env),
      breaker: scope.breaker,
      usage: { tokens24h: u.tokens, requestsLastHour: u.requestsLastHour, tokensPerDay: b.tokensPerDay, requestsPerHour: b.requestsPerHour },
    });
  }
  return { scopes };
}

/** Manual off. `forMs` makes it lapse on its own. `consumer` undefined = global. */
export function disable(consumer?: string, forMs?: number, env = process.env): void {
  updateScope(norm(consumer), (scope) => ({
    ...scope,
    mode: "off",
    until: forMs === undefined ? undefined : Date.now() + forMs,
  }), env);
}

/** Clears a manual off and closes an open breaker. */
export function enable(consumer?: string, env = process.env): void {
  updateScope(norm(consumer), ({ mode: _m, until: _u, breaker: _b, ...rest }) => rest, env);
}

/** Clears the breaker (failure count, trip) but keeps a manual off. */
export function reset(consumer?: string, env = process.env): void {
  updateScope(norm(consumer), ({ breaker: _b, ...rest }) => rest, env);
}

/** Open a consumer's breaker by hand (used by tests and operators; same effect as N failures). */
export function trip(consumer: string, reason: string, env = process.env): void {
  recordFailure(normalizeConsumer(consumer), { threshold: 1, reason, immediate: true }, Date.now(), env);
}

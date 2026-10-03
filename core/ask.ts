import { TypeSafeClient, type Questions } from "@typesafe-ai/sdk";
import { loadConfig, normalizeConsumer, type Config } from "./config.ts";
import { appendLedger, exceeded, p95Latency } from "./ledger.ts";
import { resolveKey } from "./keys.ts";
import { assertState, classifyError, fromJevResponse, toJevRequest, validateQuestions } from "./wire.ts";
import { claimProbe, effective, hasProbeWindow, readState, recordFailure, recordSuccess } from "./state.ts";
import {
  JevKitError,
  type Answer,
  type Availability,
  type AskRequest,
  type NotServed,
  type Result,
  type Unavailable,
  type Usage,
} from "./types.ts";

function normalize(name: string | undefined): string {
  try {
    return normalizeConsumer(name);
  } catch (e) {
    throw new JevKitError("invalid_input", (e as Error).message);
  }
}

/**
 * Would a call be served right now? Local and free (no network): switch, breaker, budget, key.
 * `claim` is true only for a real call: it takes the half-open probe slot, `check` must not.
 */
function gate(consumer: string, cfg: Config, env: NodeJS.ProcessEnv, claim: boolean): Availability {
  const now = Date.now();
  const no = (reason: Unavailable["reason"], detail: string): Availability => ({
    ok: false,
    consumer,
    unavailable: { reason, detail },
  });

  const state = readState(env);
  const glob = effective(state.global, undefined, now, env);
  if (glob.mode === "off") return no("disabled", `global: ${glob.detail}`);
  const scope = state.consumers[consumer] ?? {};
  const mine = effective(scope, consumer, now, env);
  if (mine.mode === "off") return no("disabled", `${consumer}: ${mine.detail}`);

  const over = exceeded(cfg, consumer, now, env);
  if (over) return no("budget", over);

  let note: string | undefined;
  if (mine.mode === "tripped") {
    const probe = hasProbeWindow(scope.breaker!, cfg.breaker.cooldownMs, now);
    if (!probe || (claim && !claimProbe(consumer, cfg.breaker.cooldownMs, now, env))) {
      return no("tripped", `${consumer}: ${mine.detail}`);
    }
    note = "breaker half-open: the next call is a probe";
  }

  if (!resolveKey(consumer, env)) return no("no_key", `no API key for consumer "${consumer}" (set TYPESAFE_API_KEY)`);
  return { ok: true, consumer, note };
}

/**
 * Local preflight, no network and no tokens. Use it to skip expensive preparation (e.g. captioning)
 * when Jev is off. It is an optimisation, not a guarantee: state can change before the call,
 * so the call itself must still be handled when it returns `ok: false`.
 */
export function check(consumer?: string, env: NodeJS.ProcessEnv = process.env): Availability {
  const c = normalize(consumer);
  return gate(c, loadConfig(env), env, false);
}

async function execute(req: AskRequest, consumer: string, cfg: Config, env: NodeJS.ProcessEnv): Promise<Result> {
  const g = gate(consumer, cfg, env, true);
  if (!g.ok) return g;

  const apiKey = resolveKey(consumer, env)!;
  const client = new TypeSafeClient({
    apiKey,
    ...(env.TYPESAFE_BASE_URL && { baseURL: env.TYPESAFE_BASE_URL }),
    timeout: req.timeoutMs ?? cfg.timeoutMs,
    ...(cfg.maxRetries !== undefined && { retry: { maxRetries: cfg.maxRetries } }),
  });
  const t0 = Date.now();
  const log = (ok: boolean, usage?: Usage) =>
    appendLedger(
      { t: t0, consumer, preset: req.preset, ok, in: usage?.input_tokens ?? 0, out: usage?.output_tokens ?? 0, ms: Date.now() - t0 },
      env,
    );

  try {
    const res = fromJevResponse(await client.systemOne(toJevRequest(req, cfg.model), { signal: req.signal }));
    log(true, res.usage);
    recordSuccess(consumer, env);
    tripOnLatency(consumer, cfg, env);
    return { ok: true, consumer, ...res };
  } catch (e) {
    const c = classifyError(e);
    if (c === null) throw e; // user abort
    if (c.kind === "invalid_input") {
      recordSuccess(consumer, env); // the service answered; the request is the problem
      throw new JevKitError("invalid_input", `Jev rejected the request: ${c.detail}`);
    }
    log(false);
    const auth = c.kind === "auth";
    const credit = c.kind === "credit";
    const reason = credit ? `credit: ${c.detail} — top up TypeSafe credits, then \`jev reset\`` : c.detail;
    recordFailure(consumer, { threshold: cfg.breaker.failures, reason, immediate: auth || credit, auth }, Date.now(), env);
    return { ok: false, consumer, unavailable: { reason: c.kind, detail: c.detail } };
  }
}

function tripOnLatency(consumer: string, cfg: Config, env: NodeJS.ProcessEnv): void {
  const ceiling = cfg.breaker.p95LatencyMs;
  if (ceiling === null) return;
  const p95 = p95Latency(consumer, cfg.breaker.latencyWindowMs, cfg.breaker.latencyMinSamples, Date.now(), env);
  if (p95 !== undefined && p95 > ceiling) {
    recordFailure(consumer, { threshold: 1, reason: `p95 latency ${p95}ms > ${ceiling}ms`, immediate: true }, Date.now(), env);
  }
}

function prepare(req: AskRequest, env: NodeJS.ProcessEnv): { consumer: string; cfg: Config } {
  const consumer = normalize(req.consumer);
  validateQuestions(req.questions);
  assertState(req.state);
  return { consumer, cfg: loadConfig(env) };
}

/**
 * Ask Jev. Returns `{ok: true, answers}` when Jev served the call, else `{ok: false, unavailable}`
 * (switched off, tripped, over budget, failing, no key). jev-kit never answers in Jev's place:
 * on `ok: false` the caller runs its own logic. Throws JevKitError only for invalid input.
 */
export async function ask(req: AskRequest, env: NodeJS.ProcessEnv = process.env): Promise<Result> {
  const { consumer, cfg } = prepare(req, env);
  return execute(req, consumer, cfg, env);
}

/**
 * Batch requests that share (consumer, state, model) into one Jev call: the state is read once
 * and all questions run in parallel. Each request still gets its own result.
 * The group's usage is reported on its first request (others 0) so totals stay honest.
 */
export async function askBatch(
  reqs: AskRequest[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<PromiseSettledResult<Result>[]> {
  const results: PromiseSettledResult<Result>[] = new Array(reqs.length);
  const groups = new Map<string, number[]>();
  const meta: ({ consumer: string; cfg: Config } | undefined)[] = [];
  reqs.forEach((r, i) => {
    try {
      meta[i] = prepare(r, env);
      const key = JSON.stringify([meta[i]!.consumer, r.state, r.model ?? null]);
      groups.set(key, [...(groups.get(key) ?? []), i]);
    } catch (e) {
      results[i] = { status: "rejected", reason: e };
    }
  });

  await Promise.all(
    [...groups.values()].map(async (idxs) => {
      const { consumer, cfg } = meta[idxs[0]]!;
      const merged: Questions = {};
      for (const i of idxs) for (const [id, q] of Object.entries(reqs[i].questions)) merged[`r${i}/${id}`] = q;
      let out: Result;
      try {
        out = await execute({ ...reqs[idxs[0]], questions: merged }, consumer, cfg, env);
      } catch (e) {
        for (const i of idxs) results[i] = { status: "rejected", reason: e };
        return;
      }
      for (const i of idxs) {
        if (!out.ok) {
          results[i] = { status: "fulfilled", value: out satisfies NotServed };
          continue;
        }
        const answers: Record<string, Answer> = {};
        for (const id of Object.keys(reqs[i].questions)) answers[id] = out.answers[`r${i}/${id}`];
        const usage = i === idxs[0] ? out.usage : { input_tokens: 0, output_tokens: 0 };
        results[i] = { status: "fulfilled", value: { ok: true, consumer, model: out.model, answers, usage } };
      }
    }),
  );
  return results;
}

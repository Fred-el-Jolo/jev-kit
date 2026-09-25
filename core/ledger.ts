import { appendFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stateDir, type Budget, type Config } from "./config.ts";

export interface LedgerEntry {
  t: number;
  consumer: string;
  preset?: string;
  ok: boolean;
  in: number;
  out: number;
  ms: number;
}

const PRUNE_ABOVE_BYTES = 5 * 1024 * 1024;
const KEEP_MS = 7 * 86_400_000;
const DAY = 86_400_000;
const HOUR = 3_600_000;

export function ledgerPath(env = process.env): string {
  return join(stateDir(env), "usage.jsonl");
}

export function appendLedger(e: LedgerEntry, env = process.env): void {
  const file = ledgerPath(env);
  mkdirSync(stateDir(env), { recursive: true, mode: 0o700 });
  appendFileSync(file, JSON.stringify(e) + "\n", { mode: 0o600 });
  try {
    if (statSync(file).size > PRUNE_ABOVE_BYTES) {
      const keep = readLedger(Date.now() - KEEP_MS, env);
      writeFileSync(file, keep.map((x) => JSON.stringify(x)).join("\n") + "\n", { mode: 0o600 });
    }
  } catch {
    // pruning is best-effort
  }
}

export function readLedger(sinceMs: number, env = process.env): LedgerEntry[] {
  let raw: string;
  try {
    raw = readFileSync(ledgerPath(env), "utf8");
  } catch {
    return [];
  }
  const out: LedgerEntry[] = [];
  for (const line of raw.split("\n")) {
    if (!line) continue;
    try {
      const e = JSON.parse(line) as LedgerEntry;
      if (e.t >= sinceMs) out.push(e);
    } catch {
      // skip a torn line
    }
  }
  return out;
}

export interface Usage24h {
  tokens: number;
  requestsLastHour: number;
}

export function summarize(entries: LedgerEntry[], consumer: string | undefined, now: number): Usage24h {
  let tokens = 0;
  let requestsLastHour = 0;
  for (const e of entries) {
    if (consumer !== undefined && e.consumer !== consumer) continue;
    if (e.t >= now - DAY) tokens += e.in + e.out;
    if (e.t >= now - HOUR) requestsLastHour++;
  }
  return { tokens, requestsLastHour };
}

export function budgetFor(cfg: Config, consumer: string): Budget {
  return { ...cfg.budget, ...cfg.consumers[consumer] };
}

/** First exhausted cap, as a human string; undefined when within budget. */
export function exceeded(cfg: Config, consumer: string, now = Date.now(), env = process.env): string | undefined {
  const per = budgetFor(cfg, consumer);
  const glob = cfg.budget;
  if (
    per.tokensPerDay === null && per.requestsPerHour === null &&
    glob.tokensPerDay === null && glob.requestsPerHour === null
  ) {
    return undefined; // no caps configured: don't read the ledger at all
  }
  const entries = readLedger(now - DAY, env);
  const mine = summarize(entries, consumer, now);
  const all = summarize(entries, undefined, now);
  const checks: [string, number, number | null][] = [
    [`${consumer}: tokens/day`, mine.tokens, per.tokensPerDay],
    [`${consumer}: requests/hour`, mine.requestsLastHour, per.requestsPerHour],
    ["global: tokens/day", all.tokens, glob.tokensPerDay],
    ["global: requests/hour", all.requestsLastHour, glob.requestsPerHour],
  ];
  for (const [label, used, cap] of checks) {
    if (cap !== null && used >= cap) return `${label} ${used}/${cap}`;
  }
  return undefined;
}

/** p95 of successful-call latency for a consumer over the window; undefined if too few samples. */
export function p95Latency(
  consumer: string,
  windowMs: number,
  minSamples: number,
  now = Date.now(),
  env = process.env,
): number | undefined {
  const ms = readLedger(now - windowMs, env)
    .filter((e) => e.consumer === consumer && e.ok)
    .map((e) => e.ms)
    .sort((a, b) => a - b);
  if (ms.length < minSamples) return undefined;
  return ms[Math.min(ms.length - 1, Math.ceil(ms.length * 0.95) - 1)];
}

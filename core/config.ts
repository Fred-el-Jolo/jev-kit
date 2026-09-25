import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface Budget {
  /** Tokens (input + output) over a rolling 24h window. null = unlimited. */
  tokensPerDay: number | null;
  /** Requests over a rolling hour. null = unlimited. */
  requestsPerHour: number | null;
}

export interface Config {
  model?: string;
  /** Per-request timeout for the SDK, ms. */
  timeoutMs: number;
  /** SDK retries per call (429/5xx/connection). Unset = SDK default. */
  maxRetries?: number;
  breaker: {
    /** Consecutive failures (after SDK retries) that trip the breaker. */
    failures: number;
    /** Time in `tripped` before one probe call is allowed. */
    cooldownMs: number;
    /** Optional p95 latency ceiling (ms) over the window; null = off. */
    p95LatencyMs: number | null;
    latencyWindowMs: number;
    /** Minimum samples in the window before the latency rule applies. */
    latencyMinSamples: number;
  };
  /** Applies to all consumers together. */
  budget: Budget;
  /** Per-consumer overrides, keyed by consumer name. */
  consumers: Record<string, Partial<Budget>>;
}

export const DEFAULT_CONFIG: Config = {
  timeoutMs: 30_000,
  breaker: {
    failures: 5,
    cooldownMs: 60_000,
    p95LatencyMs: null,
    latencyWindowMs: 10 * 60_000,
    latencyMinSamples: 10,
  },
  budget: { tokensPerDay: null, requestsPerHour: null },
  consumers: Object.create(null),
};

export function configDir(env = process.env): string {
  return join(env.XDG_CONFIG_HOME || join(homedir(), ".config"), "jev-kit");
}

export function stateDir(env = process.env): string {
  return join(env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "jev-kit");
}

export function loadConfig(env = process.env): Config {
  let user: Partial<Config> = {};
  try {
    user = JSON.parse(readFileSync(join(configDir(env), "config.json"), "utf8"));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new Error(`invalid ${join(configDir(env), "config.json")}: ${(e as Error).message}`);
    }
  }
  return {
    ...DEFAULT_CONFIG,
    ...user,
    breaker: { ...DEFAULT_CONFIG.breaker, ...user.breaker },
    budget: { ...DEFAULT_CONFIG.budget, ...user.budget },
    consumers: Object.assign(Object.create(null), user.consumers),
  };
}

/** "90s", "15m", "2h", "1d" → ms. */
export function parseDuration(s: string): number {
  const m = /^(\d+(?:\.\d+)?)(ms|s|m|h|d)$/.exec(s.trim());
  if (!m) throw new Error(`invalid duration "${s}" (use e.g. 30s, 15m, 2h, 1d)`);
  const unit = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2] as "ms"];
  return Math.round(Number(m[1]) * unit);
}

export function normalizeConsumer(name: string | undefined): string {
  const n = (name ?? "default").trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(n)) {
    throw new Error(`invalid consumer name "${n}" (letters, digits, _ . - only)`);
  }
  return n.toLowerCase();
}

export function envSuffix(consumer: string): string {
  return consumer.toUpperCase().replace(/[^A-Z0-9]/g, "_");
}

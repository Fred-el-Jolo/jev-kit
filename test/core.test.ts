import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { ask, askBatch, check, disable, enable, JevKitError, loadPresetFile, status, type AskRequest, type Result } from "../core/index.ts";
import { configDir } from "../core/config.ts";
import { startMock, testEnv, type Mock } from "./helpers.ts";

let mock: Mock;
before(async () => { mock = await startMock(); });
after(() => mock.close());

function setup(config: object = {}, extra: Record<string, string> = {}) {
  const env = testEnv(mock, extra);
  mkdirSync(configDir(env), { recursive: true });
  writeFileSync(join(configDir(env), "config.json"), JSON.stringify({ maxRetries: 0, ...config }));
  mock.requests.length = 0;
  mock.queue.length = 0;
  return env;
}

const req = (over: Partial<AskRequest> = {}): AskRequest => ({
  state: "Help! Payouts failing for 3 days.",
  questions: {
    is_urgent: { type: "noul", instructions: "Urgent?" },
    dept: { type: "choice", instructions: "Team?", criteria: { billing: null, technical: null } },
  },
  ...over,
});

/** Narrow to "not served" and return the reason. */
function reasonOf(r: Result): string {
  assert.equal(r.ok, false);
  return r.ok ? "" : r.unavailable.reason;
}

describe("ask", () => {
  it("served: answers with confidence and usage; no `source`/fallback fields exist", async () => {
    const env = setup();
    const r = await ask(req(), env);
    assert.ok(r.ok);
    assert.equal(r.answers.is_urgent.answer, 0.9);
    assert.equal("confidence" in r.answers.is_urgent, false); // noul has none in the API: absent, not null
    assert.equal(r.model, "jev-test");
    assert.equal(r.answers.dept.confidence, 0.8);
    assert.deepEqual(r.usage, { input_tokens: 296, output_tokens: 20 });
    assert.equal(mock.requests[0].auth, "Bearer test-key");
    assert.equal("source" in r, false);
  });

  it("uses the per-consumer key: env, then keys.json, then default", async () => {
    const env = setup({}, { TYPESAFE_API_KEY_ISA: "isa-key" });
    writeFileSync(join(configDir(env), "keys.json"), JSON.stringify({ photos: "photos-key" }));
    await ask(req({ consumer: "isa" }), env);
    await ask(req({ consumer: "photos" }), env);
    await ask(req({ consumer: "other" }), env);
    assert.deepEqual(mock.requests.map((r) => r.auth), ["Bearer isa-key", "Bearer photos-key", "Bearer test-key"]);
  });

  it("throws invalid_input for bad questions, before any call", async () => {
    const env = setup();
    await assert.rejects(ask(req({ questions: { q: { type: "choice", criteria: {} } } }), env), (e: JevKitError) => e.code === "invalid_input");
    assert.equal(mock.requests.length, 0);
  });

  it("maps a 422 to invalid_input without tripping the breaker", async () => {
    const env = setup({ breaker: { failures: 1 } });
    mock.queue.push([422, { detail: "bad" }]);
    await assert.rejects(ask(req(), env), (e: JevKitError) => e.code === "invalid_input");
    assert.ok((await ask(req(), env)).ok);
  });

  it("a preset may not declare a fallback", () => {
    const dir = setup();
    const file = join(configDir(dir), "bad.json");
    writeFileSync(file, JSON.stringify({ name: "bad", version: 1, questions: { q: { type: "noul" } }, fallback: { kind: "static", answers: {} } }));
    assert.throws(() => loadPresetFile(file), /fallback.*not supported/);
  });
});

describe("official output, one rename", () => {
  it("keeps every Jev field (legend, probabilities, confidence, model, usage); only noul|choice|score → answer", async () => {
    const env = setup();
    mock.queue.push([200, {
      model: "jev-1.13.0",
      answers: {
        u: { type: "noul", noul: 0.95 },
        d: { type: "choice", choice: "billing", probabilities: { billing: 0.88, sales: 0.12 }, confidence: 0.81 },
        f: { type: "score", score: 1.05, legend: { 0: "Calm", 1: "Frustrated" }, probabilities: { 0: 0, 1: 1 }, confidence: 0.92 },
      },
      usage: { input_tokens: 296, output_tokens: 20 },
    }]);
    const r = await ask(req(), env);
    assert.ok(r.ok);
    assert.equal(r.model, "jev-1.13.0");
    assert.deepEqual(r.answers, {
      u: { type: "noul", answer: 0.95 },
      d: { type: "choice", answer: "billing", probabilities: { billing: 0.88, sales: 0.12 }, confidence: 0.81 },
      f: { type: "score", answer: 1.05, legend: { 0: "Calm", 1: "Frustrated" }, probabilities: { 0: 0, 1: 1 }, confidence: 0.92 },
    });
    assert.deepEqual(r.usage, { input_tokens: 296, output_tokens: 20 });
  });
});

describe("model", () => {
  it("request > config; absent means the SDK default", async () => {
    const env = setup({ model: "jev-cfg" });
    await ask(req({ model: "jev-req" }), env);
    await ask(req(), env);
    assert.deepEqual(mock.requests.map((r) => r.body.model), ["jev-req", "jev-cfg"]);
    const env2 = setup();
    await ask(req(), env2);
    assert.equal(mock.requests[0].body.model, "jev-latest");
  });

  it("preset `model` is loaded and validated", () => {
    const dir = configDir(setup());
    const file = join(dir, "m.json");
    writeFileSync(file, JSON.stringify({ name: "m", version: 1, model: "jev-1.13.0", questions: { q: { type: "noul" } } }));
    assert.equal(loadPresetFile(file).model, "jev-1.13.0");
    writeFileSync(file, JSON.stringify({ name: "m", version: 1, model: 3, questions: { q: { type: "noul" } } }));
    assert.throws(() => loadPresetFile(file), /"model" must be a non-empty string/);
  });
});

describe("hardening", () => {
  it("consumer names that collide with Object.prototype members behave like any other", async () => {
    const env = setup({ consumers: { constructor: { tokensPerDay: 1 } } });
    disable("constructor", undefined, env);
    assert.equal(reasonOf(await ask(req({ consumer: "constructor" }), env)), "disabled");
    enable("constructor", env);
    assert.ok((await ask(req({ consumer: "constructor" }), env)).ok);
    assert.equal(reasonOf(await ask(req({ consumer: "constructor" }), env)), "budget"); // its own 1-token cap applies
  });

  it("state and ledger files are private (0600 in a 0700 dir)", async () => {
    const { statSync } = await import("node:fs");
    const env = setup();
    await ask(req(), env);
    disable(undefined, undefined, env);
    const dir = join(env.XDG_STATE_HOME!, "jev-kit");
    assert.equal(statSync(dir).mode & 0o777, 0o700);
    for (const f of ["usage.jsonl", "state.json"]) assert.equal(statSync(join(dir, f)).mode & 0o777, 0o600, f);
  });

  it("preset templates cannot reach prototype members", async () => {
    const { buildState } = await import("../core/presets.ts");
    const preset = { name: "t", version: 1, questions: {}, path: "", state: { template: "{{constructor}}" } } as any;
    assert.throws(() => buildState(preset, { a: 1 }), (e: JevKitError) => e.code === "invalid_input");
  });
});

describe("switch", () => {
  it("disabled → not served, reason=disabled, no request; enable restores", async () => {
    const env = setup();
    disable(undefined, undefined, env);
    const r = await ask(req(), env);
    assert.equal(reasonOf(r), "disabled");
    assert.equal("answers" in r, false); // nothing is invented
    assert.equal(mock.requests.length, 0);
    enable(undefined, env);
    assert.ok((await ask(req(), env)).ok);
  });

  it("consumer switch only affects that consumer", async () => {
    const env = setup();
    disable("isa", undefined, env);
    assert.equal(reasonOf(await ask(req({ consumer: "isa" }), env)), "disabled");
    assert.ok((await ask(req({ consumer: "photos" }), env)).ok);
  });

  it("env JEV_KIT=off wins over the state file; timed disable lapses", async () => {
    const env = setup();
    assert.equal(reasonOf(await ask(req(), { ...env, JEV_KIT: "off" })), "disabled");
    disable(undefined, 1, env);
    await new Promise((r) => setTimeout(r, 10));
    assert.ok((await ask(req(), env)).ok);
  });
});

describe("check (local preflight)", () => {
  it("reports availability without any request and without consuming state", async () => {
    const env = setup();
    assert.deepEqual(check("isa", env), { ok: true, consumer: "isa", note: undefined });
    disable("isa", undefined, env);
    const c = check("isa", env);
    assert.ok(!c.ok && c.unavailable.reason === "disabled");
    assert.equal(mock.requests.length, 0);
  });

  it("reports budget, missing key and tripped; half-open check does not steal the probe", async () => {
    const env = setup({ consumers: { a: { requestsPerHour: 1 } }, breaker: { failures: 1, cooldownMs: 50 } });
    await ask(req({ consumer: "a" }), env);
    const b = check("a", env);
    assert.ok(!b.ok && b.unavailable.reason === "budget");

    const noKey = { ...env };
    delete noKey.TYPESAFE_API_KEY;
    const k = check("b", noKey);
    assert.ok(!k.ok && k.unavailable.reason === "no_key");

    mock.queue.push([500, {}]);
    await ask(req({ consumer: "t" }), env);
    const t = check("t", env);
    assert.ok(!t.ok && t.unavailable.reason === "tripped");
    await new Promise((r) => setTimeout(r, 70));
    const half = check("t", env);
    assert.ok(half.ok && /probe/.test(half.note!));
    check("t", env); // repeated checks must not consume the probe slot
    assert.ok((await ask(req({ consumer: "t" }), env)).ok);
  });
});

describe("breaker", () => {
  it("trips after N consecutive failures, stops calling, then probes and recovers", async () => {
    const env = setup({ breaker: { failures: 2, cooldownMs: 50 } });
    mock.queue.push([500, {}], [500, {}]);
    assert.equal(reasonOf(await ask(req(), env)), "error");
    assert.equal(reasonOf(await ask(req(), env)), "error"); // trips here
    const before = mock.requests.length;
    assert.equal(reasonOf(await ask(req(), env)), "tripped");
    assert.equal(mock.requests.length, before); // no call while open
    assert.equal(status([], env).scopes.find((s) => s.consumer === "default")!.effective.mode, "tripped");
    await new Promise((r) => setTimeout(r, 70));
    assert.ok((await ask(req(), env)).ok); // probe succeeds → closed
    assert.equal(status(["default"], env).scopes.find((s) => s.consumer === "default")!.effective.mode, "on");
  });

  it("a failed probe re-opens the breaker", async () => {
    const env = setup({ breaker: { failures: 1, cooldownMs: 50 } });
    mock.queue.push([500, {}]);
    await ask(req(), env);
    await new Promise((r) => setTimeout(r, 70));
    mock.queue.push([500, {}]);
    assert.equal(reasonOf(await ask(req(), env)), "error"); // probe failed
    assert.equal(reasonOf(await ask(req(), env)), "tripped");
  });

  it("401 → reason auth, trips that consumer only", async () => {
    const env = setup({ breaker: { failures: 5 } });
    mock.queue.push([401, { error: "nope" }]);
    assert.equal(reasonOf(await ask(req({ consumer: "isa" }), env)), "auth");
    assert.equal(reasonOf(await ask(req({ consumer: "isa" }), env)), "tripped");
    assert.ok((await ask(req({ consumer: "photos" }), env)).ok);
  });

  it("402 → credit, trips at once, check says to top up", async () => {
    const env = setup({ breaker: { failures: 5 } });
    mock.queue.push([402, { error: "payment required" }]);
    assert.equal(reasonOf(await ask(req({ consumer: "isa" }), env)), "credit");
    const c = check("isa", env);
    assert.ok(!c.ok && c.unavailable.reason === "tripped" && /top up TypeSafe credits/.test(c.unavailable.detail));
    assert.equal(mock.requests.length, 1);
  });

  it("missing key → no_key, no request, state untouched", async () => {
    const env = setup();
    delete env.TYPESAFE_API_KEY;
    assert.equal(reasonOf(await ask(req(), env)), "no_key");
    assert.equal(mock.requests.length, 0);
    assert.deepEqual(status([], env).scopes.map((s) => s.consumer), [null]);
  });
});

describe("budget", () => {
  it("not served once tokens/day is spent; other consumers unaffected", async () => {
    const env = setup({ consumers: { isa: { tokensPerDay: 300 } } });
    assert.ok((await ask(req({ consumer: "isa" }), env)).ok); // 316 tokens
    assert.equal(reasonOf(await ask(req({ consumer: "isa" }), env)), "budget");
    assert.ok((await ask(req({ consumer: "photos" }), env)).ok);
  });

  it("global request cap applies across consumers", async () => {
    const env = setup({ budget: { requestsPerHour: 2 } });
    await ask(req({ consumer: "a" }), env);
    await ask(req({ consumer: "b" }), env);
    assert.equal(reasonOf(await ask(req({ consumer: "c" }), env)), "budget");
  });
});

describe("askBatch", () => {
  it("merges same-state requests into one call and splits the answers", async () => {
    const env = setup();
    const a = req({ questions: { q: { type: "noul", instructions: "A?" } } });
    const b = req({ questions: { q: { type: "noul", instructions: "B?" }, w: { type: "noul", instructions: "C?" } } });
    const other = req({ state: "different" });
    const res = await askBatch([a, b, other], env);
    assert.equal(mock.requests.length, 2); // one for (a,b), one for other
    const [ra, rb] = res.map((r) => (r as PromiseFulfilledResult<any>).value);
    assert.deepEqual(Object.keys(ra.answers), ["q"]);
    assert.deepEqual(Object.keys(rb.answers), ["q", "w"]);
    assert.equal(ra.usage.input_tokens, 296);
    assert.equal(rb.usage.input_tokens, 0);
  });

  it("when Jev is off every request is individually not served", async () => {
    const env = setup();
    disable(undefined, undefined, env);
    const res = await askBatch([req(), req()], env);
    for (const r of res) assert.equal(reasonOf((r as PromiseFulfilledResult<Result>).value), "disabled");
  });
});

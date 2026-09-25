import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { startMock, testEnv, type Mock } from "./helpers.ts";

let mock: Mock;
before(async () => { mock = await startMock(); });
after(() => mock.close());

const CLI = join(import.meta.dirname, "..", "cli", "jev.ts");
const presets = join(import.meta.dirname, "..", "presets");

// Async spawn: the mock server lives in this process, so the event loop must stay free.
function jev(args: string[], input: string | undefined, env: NodeJS.ProcessEnv) {
  return new Promise<{ code: number | null; out: any; err: any }>((resolve) => {
    const c = spawn(process.execPath, [CLI, ...args], { env: { ...env, JEV_KIT_PRESETS: presets } });
    let out = "";
    let err = "";
    c.stdout.on("data", (d) => (out += d));
    c.stderr.on("data", (d) => (err += d));
    c.on("close", (code) => resolve({ code, out: out ? JSON.parse(out) : undefined, err: err ? JSON.parse(err) : undefined }));
    c.stdin.end(input ?? "");
  });
}

describe("jev CLI", () => {
  it("run <preset> → envelope from Jev, exit 0", async () => {
    const env = testEnv(mock);
    const r = await jev(["run", "urgency", "--text", "--consumer", "isa"], "Help! Payouts failing.", env);
    assert.equal(r.code, 0);
    assert.equal(r.out.ok, true);
    assert.equal(r.out.consumer, "isa");
    assert.deepEqual(Object.keys(r.out.answers).sort(), ["department", "frustration", "is_urgent"]);
  });

  it("disable → not served: envelope on stdout, exit 4, no invented answers → check → enable", async () => {
    const env = testEnv(mock);
    assert.equal((await jev(["disable", "--for", "1h"], undefined, env)).code, 0);
    const r = await jev(["run", "urgency", "--text"], "hi", env);
    assert.equal(r.code, 4);
    assert.deepEqual(r.out, { ok: false, consumer: "default", unavailable: { reason: "disabled", detail: r.out.unavailable.detail } });
    const c = await jev(["check"], undefined, env);
    assert.equal(c.code, 4);
    assert.equal(c.out.unavailable.reason, "disabled");
    await jev(["enable"], undefined, env);
    assert.equal((await jev(["check"], undefined, env)).code, 0);
    assert.equal((await jev(["run", "urgency", "--text"], "hi", env)).out.ok, true);
    assert.equal(mock.requests.length > 0, true);
  });

  it("run uses the preset's model", async () => {
    const env = testEnv(mock);
    const dir = mkdtempSync(join(tmpdir(), "jev-presets-"));
    writeFileSync(join(dir, "pinned.json"), JSON.stringify({ name: "pinned", version: 1, model: "jev-1.13.0", questions: { q: { type: "noul", instructions: "?" } } }));
    mock.requests.length = 0;
    const c = spawn(process.execPath, [CLI, "run", "pinned", "--text"], { env: { ...env, JEV_KIT_PRESETS: dir } });
    c.stdin.end("hi");
    await new Promise((r) => c.on("close", r));
    assert.equal(mock.requests[0].body.model, "jev-1.13.0");
  });

  it("exit code: no key → 3", async () => {
    const env = testEnv(mock);
    delete env.TYPESAFE_API_KEY;
    const r = await jev(["run", "urgency", "--text"], "hi", env);
    assert.equal(r.code, 3);
    assert.equal(r.out.unavailable.reason, "no_key");
  });

  it("ask with ad-hoc request; bad input → exit 2", async () => {
    const env = testEnv(mock);
    const body = JSON.stringify({ state: { text: "x" }, questions: { u: { type: "noul", instructions: "?" } } });
    assert.equal((await jev(["ask"], body, env)).out.ok, true);
    assert.equal((await jev(["ask"], "{nope", env)).code, 2);
    assert.equal((await jev(["run", "does-not-exist"], "x", env)).code, 2);
    assert.equal((await jev(["ask"], JSON.stringify({ state: "x", questions: { u: { type: "wat" } } }), env)).code, 2);
  });

  it("status lists scopes; presets lists the example", async () => {
    const env = testEnv(mock);
    await jev(["disable", "--consumer", "isa"], undefined, env);
    const s = await jev(["status"], undefined, env);
    assert.equal(s.out.scopes[0].consumer, null);
    assert.equal(s.out.scopes.find((x: any) => x.consumer === "isa").effective.mode, "off");
    assert.ok((await jev(["presets"], undefined, env)).out.some((p: any) => p.name === "urgency"));
  });

  it("claude hook: injects context when Jev served; silent when unavailable; never fails", async () => {
    const env = testEnv(mock);
    const hook = (input: string, extra: string[] = []) =>
      new Promise<{ code: number | null; out: string }>((resolve) => {
        const c = spawn(process.execPath, [join(import.meta.dirname, "..", "adapters", "claude", "hook.ts"), "--preset", "urgency", "--field", "prompt", ...extra], {
          env: { ...env, JEV_KIT_PRESETS: presets },
        });
        let out = "";
        c.stdout.on("data", (d) => (out += d));
        c.on("close", (code) => resolve({ code, out }));
        c.stdin.end(input);
      });
    const payload = JSON.stringify({ hook_event_name: "UserPromptSubmit", prompt: "Help!" });
    const ok = await hook(payload);
    assert.equal(ok.code, 0);
    const ctx = JSON.parse(ok.out).hookSpecificOutput;
    assert.equal(ctx.hookEventName, "UserPromptSubmit");
    assert.match(ctx.additionalContext, /^jev:urgency /);
    await jev(["disable"], undefined, env);
    assert.equal((await hook(payload)).out, "");
    assert.deepEqual(await hook("not json"), { code: 0, out: "" });
  });
});

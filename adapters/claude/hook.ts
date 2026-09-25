#!/usr/bin/env node
/**
 * Generic Claude Code hook helper → the `jev` CLI.
 *
 *   hook.ts --preset <name> [--consumer <c>] [--field prompt]
 *
 * Reads the hook payload on stdin, runs the preset with `--field` of it as the state (default:
 * the whole payload), and returns the answers as `additionalContext` for events that support it
 * (UserPromptSubmit, SessionStart, …). It NEVER blocks the agent: if Jev is unavailable or anything
 * fails, it prints nothing and exits 0 — the agent simply proceeds without the judgment.
 */
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";

const { values: v } = parseArgs({
  options: {
    preset: { type: "string" },
    consumer: { type: "string" },
    field: { type: "string" },
  },
});

const CLI = new URL("../../cli/jev.ts", import.meta.url).pathname;

function run(args: string[], input: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const c = spawn(process.execPath, [CLI, ...args], { stdio: ["pipe", "pipe", "ignore"] });
    let out = "";
    c.stdout.on("data", (d) => (out += d));
    c.on("error", reject);
    c.on("close", (code) => (code === 0 ? resolve(out) : reject(new Error(`jev exit ${code}`))));
    c.stdin.end(input);
  });
}

try {
  if (!v.preset) throw new Error("--preset is required");
  const payload = JSON.parse(readFileSync(0, "utf8"));
  const state = v.field ? payload[v.field] : payload;
  const args = ["run", v.preset, ...(v.consumer ? ["--consumer", v.consumer] : [])];
  const res = JSON.parse(await run(args, JSON.stringify(state)));
  const answers = Object.fromEntries(
    Object.entries<any>(res.answers).map(([k, a]) => [k, a.confidence == null ? a.answer : { answer: a.answer, confidence: a.confidence }]),
  );
  const ctx = `jev:${v.preset} ${JSON.stringify(answers)}`;
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: payload.hook_event_name, additionalContext: ctx } }) + "\n");
} catch {
  // never block the agent on a judgment aid
}

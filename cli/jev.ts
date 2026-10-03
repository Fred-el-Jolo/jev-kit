#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import {
  ask,
  buildState,
  check,
  disable,
  enable,
  EXIT_CODES,
  exitCodeFor,
  JevKitError,
  listPresets,
  loadPreset,
  parseDuration,
  reset,
  status,
  validateQuestions,
  type AskRequest,
  type Json,
  type Result,
  type Availability,
} from "../core/index.ts";

const HELP = `jev — typed judgments over text state (TypeSafe Jev), with a shared off-switch

  jev run <preset> [--in file|-] [--text]   run a preset; input is the state (JSON, or raw text with --text)
  jev ask [--in file|-]                     ad-hoc: {"state": …, "questions": {…}, "consumer"?, "model"?}
  jev check                                 local preflight (no network, no tokens): would a call be served now?
  jev presets                               list presets on the search path
  jev status                                on/off/tripped per scope, breaker, token usage
  jev enable | disable [--for 2h] | reset   flip the shared switch (reset = clear the breaker only)

  --consumer <name>   caller label; picks the API key, budget, breaker and switch (default: "default")

jev never answers in Jev's place. When Jev can't serve a call, stdout is
  {"ok":false,"consumer":…,"unavailable":{"reason":…,"detail":…}}
and the exit code is non-zero, so the caller can run its own logic:  jev run x < in.json || my-heuristic

Exit codes: 0 served · 2 invalid input · 3 auth / no key · 4 unavailable (disabled, tripped, credit, error) · 5 budget
Invalid input is JSON on stderr; "unavailable" is JSON on stdout.
Presets: $JEV_KIT_PRESETS, ~/.config/jev-kit/presets, ./presets.`;

function fail(code: "invalid_input", message: string): never {
  process.stderr.write(JSON.stringify({ ok: false, error: { code, message } }) + "\n");
  process.exit(EXIT_CODES[code]);
}

async function readInput(path: string | undefined): Promise<string> {
  if (path && path !== "-") {
    try {
      return readFileSync(path, "utf8");
    } catch (e) {
      return fail("invalid_input", `cannot read ${path}: ${(e as Error).message}`);
    }
  }
  if (process.stdin.isTTY) return fail("invalid_input", "no input: pass --in <file> or pipe JSON on stdin");
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

function parseJson(raw: string, what: string): unknown {
  try {
    return JSON.parse(raw);
  } catch (e) {
    return fail("invalid_input", `${what} is not valid JSON: ${(e as Error).message}`);
  }
}

async function main(): Promise<void> {
  let parsed;
  try {
    parsed = parseArgs({
      allowPositionals: true,
      options: {
        in: { type: "string" },
        text: { type: "boolean" },
        consumer: { type: "string" },
        for: { type: "string" },
        help: { type: "boolean", short: "h" },
      },
    });
  } catch (e) {
    return fail("invalid_input", (e as Error).message);
  }
  const { values: v, positionals: [cmd, arg] } = parsed;
  if (!cmd || v.help || cmd === "help") {
    process.stdout.write(HELP + "\n");
    return;
  }
  const out = (x: unknown): void => {
    process.stdout.write(JSON.stringify(x) + "\n");
  };
  // Not served is not an error: the envelope goes to stdout, the exit code tells the caller.
  const outcome = (r: Result | Availability): void => {
    out(r);
    if (!r.ok) process.exitCode = exitCodeFor(r.unavailable);
  };

  switch (cmd) {
    case "run": {
      if (!arg) return fail("invalid_input", "usage: jev run <preset> [--in file|-]");
      const preset = loadPreset(arg);
      const raw = await readInput(v.in);
      const input = (v.text ? raw : parseJson(raw, "input")) as Json;
      const req: AskRequest = {
        state: buildState(preset, input),
        questions: preset.questions,
        consumer: v.consumer ?? preset.consumer,
        model: preset.model,
        preset: `${preset.name}@${preset.version}`,
      };
      return outcome(await ask(req));
    }
    case "ask": {
      const body = parseJson(await readInput(v.in), "input") as any;
      if (!body || typeof body !== "object") return fail("invalid_input", "input must be an object");
      validateQuestions(body.questions);
      const req: AskRequest = {
        state: body.state,
        questions: body.questions,
        consumer: v.consumer ?? body.consumer,
        model: body.model,
      };
      return outcome(await ask(req));
    }
    case "check":
      return outcome(check(v.consumer));
    case "presets":
      return void out(listPresets());
    case "status":
      return void out(status(v.consumer ? [v.consumer] : []));
    case "enable":
      enable(v.consumer);
      return void out(status(v.consumer ? [v.consumer] : []));
    case "disable":
      disable(v.consumer, v.for ? parseDuration(v.for) : undefined);
      return void out(status(v.consumer ? [v.consumer] : []));
    case "reset":
      reset(v.consumer);
      return void out(status(v.consumer ? [v.consumer] : []));
    default:
      return fail("invalid_input", `unknown command "${cmd}" (try: jev help)`);
  }
}

main().catch((e) => {
  if (e instanceof JevKitError) fail(e.code, e.message);
  fail("invalid_input", (e as Error).message);
});

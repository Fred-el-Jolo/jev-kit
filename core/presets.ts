import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { configDir } from "./config.ts";
import { assertState, validateQuestions } from "./wire.ts";
import { JevKitError, type Json, type Preset, type State } from "./types.ts";

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

/** $JEV_KIT_PRESETS (colon-separated) → ~/.config/jev-kit/presets → ./presets */
export function searchPath(env = process.env, cwd = process.cwd()): string[] {
  const fromEnv = (env.JEV_KIT_PRESETS ?? "").split(":").filter(Boolean).map((p) => resolve(cwd, expandHome(p)));
  return [...fromEnv, join(configDir(env), "presets"), resolve(cwd, "presets")];
}

function expandHome(p: string): string {
  return p === "~" || p.startsWith("~/") ? join(homedir(), p.slice(1)) : p;
}

export function loadPresetFile(path: string): Preset {
  let raw: any;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new JevKitError("invalid_input", `cannot read preset ${path}: ${(e as Error).message}`);
  }
  const name = String(raw.name ?? basename(path, ".json"));
  const where = `preset ${path}`;
  if (raw.version === undefined) throw new JevKitError("invalid_input", `${where}: "version" is required`);
  if (raw.model !== undefined && (typeof raw.model !== "string" || !raw.model)) {
    throw new JevKitError("invalid_input", `${where}: "model" must be a non-empty string`);
  }
  validateQuestions(raw.questions, where);
  if (raw.state !== undefined && typeof raw.state?.template !== "string") {
    throw new JevKitError("invalid_input", `${where}: "state" must be { "template": "…" }`);
  }
  if (raw.fallback !== undefined) {
    throw new JevKitError("invalid_input", `${where}: "fallback" is not supported — jev-kit never answers for Jev; handle unavailability in the caller`);
  }
  return {
    name,
    version: raw.version,
    description: raw.description,
    consumer: raw.consumer,
    model: raw.model,
    state: raw.state,
    questions: raw.questions,
    path,
  };
}

export function loadPreset(name: string, env = process.env, cwd = process.cwd()): Preset {
  if (!NAME_RE.test(name)) throw new JevKitError("invalid_input", `invalid preset name "${name}"`);
  for (const dir of searchPath(env, cwd)) {
    const file = join(dir, `${name}.json`);
    if (existsSync(file)) return loadPresetFile(file);
  }
  throw new JevKitError("invalid_input", `preset "${name}" not found in: ${searchPath(env, cwd).join(", ")}`);
}

export function listPresets(env = process.env, cwd = process.cwd()): { name: string; version: Preset["version"]; path: string }[] {
  const seen = new Set<string>();
  const out: { name: string; version: Preset["version"]; path: string }[] = [];
  for (const dir of searchPath(env, cwd)) {
    let files: string[];
    try {
      files = readdirSync(dir).filter((f) => f.endsWith(".json"));
    } catch {
      continue;
    }
    for (const f of files) {
      const n = basename(f, ".json");
      if (seen.has(n)) continue; // earlier search-path entries shadow later ones
      seen.add(n);
      try {
        const p = loadPresetFile(join(dir, f));
        out.push({ name: p.name, version: p.version, path: p.path });
      } catch {
        out.push({ name: n, version: "invalid", path: join(dir, f) });
      }
    }
  }
  return out;
}

/** Build `state` from the caller's input via the preset's template, or pass the input through. */
export function buildState(preset: Preset, input: Json): State {
  if (!preset.state) return assertState(input);
  return preset.state.template.replace(/\{\{\s*([^}]*?)\s*\}\}/g, (_, path: string) => {
    let cur: any = input;
    if (path !== ".") {
      for (const part of path.split(".")) {
        if (cur === null || typeof cur !== "object" || !Object.hasOwn(cur, part)) {
          throw new JevKitError("invalid_input", `preset "${preset.name}": input has no "${path}"`);
        }
        cur = cur[part];
      }
    }
    return typeof cur === "string" ? cur : JSON.stringify(cur);
  });
}

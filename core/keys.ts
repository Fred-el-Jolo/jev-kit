import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { configDir, envSuffix } from "./config.ts";

let warned = false;

/**
 * Resolution order for consumer X:
 * TYPESAFE_API_KEY_X → keys.json {"x": "…"} → TYPESAFE_API_KEY.
 */
export function resolveKey(consumer: string, env = process.env): string | undefined {
  const fromEnv = env[`TYPESAFE_API_KEY_${envSuffix(consumer)}`];
  if (fromEnv) return fromEnv;
  const file = join(configDir(env), "keys.json");
  try {
    const mode = statSync(file).mode;
    if (mode & 0o077 && !warned) {
      warned = true;
      process.stderr.write(`jev-kit: warning: ${file} is readable by others (mode ${(mode & 0o777).toString(8)}); run: chmod 600 ${file}\n`);
    }
    const keys = Object.assign(Object.create(null), JSON.parse(readFileSync(file, "utf8")));
    if (typeof keys[consumer] === "string" && keys[consumer]) return keys[consumer];
  } catch {
    // missing or unreadable keys.json: fall through to the default key
  }
  return env.TYPESAFE_API_KEY || undefined;
}

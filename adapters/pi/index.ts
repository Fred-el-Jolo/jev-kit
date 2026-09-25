/**
 * pi extension: generic jev tools + /jev command, in-process via core (no subprocess).
 * Load with `pi -e /path/to/jev-kit/adapters/pi/index.ts`, or list it in pi settings.
 * Shares the on/off state with the CLI and every other surface.
 */
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { ask, buildState, check, disable, enable, listPresets, loadPreset, parseDuration, reset, status } from "../../core/index.ts";

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }], details: undefined });

const jevAsk = defineTool({
  name: "jev_ask",
  label: "Jev",
  description:
    "Ask Jev (TypeSafe System One) typed questions about a text state: noul (yes/no probability), choice (one of N options) or score (ordered levels). " +
    "Questions are batched in one call over the same state. If Jev cannot serve the call the result is {ok:false, unavailable:{reason,detail}}: do NOT guess the answers, proceed without Jev.",
  parameters: Type.Object({
    state: Type.Union([Type.String(), Type.Record(Type.String(), Type.Any()), Type.Array(Type.Any())], { description: "Text or JSON to judge" }),
    questions: Type.Record(Type.String(), Type.Any(), {
      description: 'Map id → {"type":"noul"|"choice"|"score","instructions":…,"criteria":…}',
    }),
    consumer: Type.Optional(Type.String({ description: "Caller label (key, budget, breaker, switch). Default: default" })),
  }),
  async execute(_id, p, signal) {
    const r = await ask({ state: p.state, questions: p.questions, consumer: p.consumer, signal });
    return { ...text(JSON.stringify(r)), details: r };
  },
});

const jevRun = defineTool({
  name: "jev_run",
  label: "Jev preset",
  description: "Run a named jev preset (a saved question set) on an input. Use jev_ask for ad-hoc questions.",
  parameters: Type.Object({
    preset: Type.String(),
    input: Type.Union([Type.String(), Type.Record(Type.String(), Type.Any()), Type.Array(Type.Any())]),
    consumer: Type.Optional(Type.String()),
  }),
  async execute(_id, p, signal) {
    const preset = loadPreset(p.preset);
    const r = await ask({
      state: buildState(preset, p.input),
      questions: preset.questions,
      consumer: p.consumer ?? preset.consumer,
      model: preset.model,
      preset: `${preset.name}@${preset.version}`,
      signal,
    });
    return { ...text(JSON.stringify(r)), details: r };
  },
});

export default function (pi: ExtensionAPI) {
  pi.registerTool(jevAsk);
  pi.registerTool(jevRun);
  pi.registerCommand("jev", {
    description: "jev status | check | on | off [2h] | reset | presets   (add --consumer <name> to scope)",
    handler: async (args, ctx) => {
      const words = args.trim().split(/\s+/).filter(Boolean);
      const ci = words.indexOf("--consumer");
      const consumer = ci >= 0 ? words.splice(ci, 2)[1] : undefined;
      const [sub = "status", dur] = words;
      try {
        if (sub === "off") disable(consumer, dur ? parseDuration(dur) : undefined);
        else if (sub === "on") enable(consumer);
        else if (sub === "reset") reset(consumer);
        else if (sub === "check") {
          const a = check(consumer);
          return ctx.ui.notify(a.ok ? `available${a.note ? ` (${a.note})` : ""}` : `unavailable: ${a.unavailable.reason} — ${a.unavailable.detail}`, a.ok ? "info" : "warning");
        } else if (sub === "presets") return ctx.ui.notify(listPresets().map((p) => `${p.name}@${p.version}`).join("\n") || "no presets", "info");
        else if (sub !== "status") return ctx.ui.notify(`unknown: ${sub}`, "error");
        const lines = status(consumer ? [consumer] : []).scopes.map((s) => {
          const e = s.effective;
          return `${s.consumer ?? "(global)"}: ${e.mode}${e.detail ? ` — ${e.detail}` : ""}`;
        });
        ctx.ui.notify(lines.join("\n"), "info");
      } catch (e) {
        ctx.ui.notify((e as Error).message, "error");
      }
    },
  });
}

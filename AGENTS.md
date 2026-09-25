# jev-kit

Generic Jev (TypeSafe System One) wrapper. Read [DESIGN.md](DESIGN.md) first — it holds the decisions.

- **Propose, don't impose:** the design is a proposal; don't implement until told to.
- **Stack:** TypeScript on Node 24 (type stripping, no build step), mise-pinned. One runtime dep: `@typesafe-ai/sdk`.
- **No MCP.** Surfaces are: in-process library, CLI, pi extension, Claude skill/hooks.
- **Generic only:** no use-case logic here (ISA, photos, …). Those are external modules that bring their own presets.
- **Jev docs are the source of truth:** https://docs.typesafe.ai/llms.txt (append `.md` to page paths). Jev is text-only.
- **Secrets:** `TYPESAFE_API_KEY` comes from the environment; never commit it.
- **No fallback answers, ever.** When Jev can't serve a call (off, tripped, over budget, failing) the result is `{ok:false, unavailable}` — never invented, static or heuristic answers. Each caller implements its own fallback in its own module.
- **Jev wire format lives only in `core/wire.ts`** (request/response/error mapping); every difference from the official API is listed in [docs/JEV-MAPPING.md](docs/JEV-MAPPING.md). Keep both in sync when the API changes.

# jev-kit — design (implemented)

A **generic** wrapper around [Jev](https://docs.typesafe.ai) (TypeSafe System One): typed
judgments (Choice / Noul / Score) over text state. Usable from **pi**, **Claude Code** and
plain scripts/apps. **No MCP** — by choice, and pi has none anyway.

jev-kit knows nothing about any use case. Consumers live in their own modules and bring
their own questions (presets). Known future consumers, kept in mind but **not** encoded here:
- an ISA (ideal-state artifact) module: many small routing / selection / scoring / verification
  judgments, called from agent hooks — so latency, batching and a reliable off-switch matter;
- photo triage: Jev is text-only, so pixels need a captioning step in the consumer first.

## Jev facts that shape the design

- Text only (string / JSON / array of text). 64k ctx per request, 32k for `state` + longest question.
- `state` is read once, all questions run in parallel → **batch questions over the same state**.
- Limits: 1,200 req/min, 250k tok/s (dynamic). SDK retries 429 with backoff by default.
- Answers carry calibrated confidence; responses carry `usage` (input/output tokens).
- HTTP API: `POST https://api.typesafe.ai/v1/systemone`, bearer `TYPESAFE_API_KEY`.

## Layout

```
core/            SDK wrapper, preset loader, batching, kill-switch + breaker + budgets (only place touching the API)
cli/             `jev` — JSON in / JSON out; the surface every consumer can shell out to
presets/         generic examples / test fixtures only — real presets live in consumer modules
adapters/pi/     pi extension: generic tools + events -> core (in-process)
adapters/claude/ generic SKILL.md + hook helper -> cli
```

Stack: TypeScript on Node 24 (type stripping, no build step), pinned by `mise.toml`.
Only runtime dep: `@typesafe-ai/sdk`. Anything use-case specific (`sharp`, `exifr`, markdown
parsing…) belongs to the consumer module, which depends on `core`.

## Surfaces

| Consumer | Path |
|---|---|
| pi | extension imports `core` (typed tool schema, no subprocess) |
| Claude Code | skill teaches the CLI; hooks (`UserPromptSubmit`, …) call the CLI |
| scripts / apps / other modules | import `core`, or `jev run … \| jq` |

All surfaces share one behavior and **one on/off state** (below).

## Presets (generic, external)

A preset = named, versioned question set + how to build `state`, with optional `consumer` and
`model`. (No fallback policy: see below.) Model precedence: request `model` > preset `model` >
`config.json` `model` > SDK default (`jev-latest`). Pin a versioned id (e.g. `jev-1.13.0`) if you
tuned confidence thresholds: the alias moves when a new release ships.
Core only loads and runs them. Search path, in order: `$JEV_KIT_PRESETS` (colon-separated) →
`~/.config/jev-kit/presets` → `./presets`. A consumer module registers its own directory;
jev-kit never depends on it. Format (JSON vs TS module) is an open question.

`jev run <preset> --in state.json` and an ad-hoc mode `jev ask --in request.json`
(raw `state` + `questions`, no preset).

## Consumers and API keys

Every call carries a `consumer` name (`--consumer isa`, or `consumer` in a preset / the library
call; default `default`). It is a plain label owned by the caller — jev-kit knows no consumers.

- **One TypeSafe key per consumer**, plus one default key for ad-hoc use. Reason: revocation
  and rotation of one consumer without touching the others, and per-key usage attribution
  *if* the console provides it (the public docs don't say; a key is only documented as a
  bearer credential). The 1,200 req/min limit is documented per account, so separate keys
  may not isolate consumers from each other's rate limit.
- **Keys are not the cost control.** Budgets, breaker and kill switch live in jev-kit and are
  tracked **per consumer** (see below), so they work even if consumers share a key.
- **Resolution order** for consumer `X`: `TYPESAFE_API_KEY_X` (env, upper-cased, `-` → `_`) →
  `~/.config/jev-kit/keys.json` (`{ "x": "…" }`, mode 600) → `TYPESAFE_API_KEY`. jev-kit
  passes the resolved key explicitly to the SDK. Never in a repo; the default key
  goes in mise `[env]` (`~/.config/mise/config.toml`).
- A 401 on consumer X's key trips only X's breaker.

## Enable / disable — and no fallback

Goal: one switch that every surface honors, and **no system that fully depends on Jev**. If Jev is
disabled, too expensive or down, callers must keep working — but *how* is use-case knowledge.
jev-kit therefore **never answers in Jev's place**: no static, generic or heuristic answers, no
`exec` hook. When Jev can't serve a call it says so, and the caller runs its own logic, written
in the caller's own module. (A generic fallback is worse than none: it looks like a judgment.)

### State

| State | Set by | Meaning |
|---|---|---|
| `on` | default | call Jev |
| `off` | `jev disable [--for 2h]` (manual, optionally expiring) | never call Jev |
| `tripped` | automatic | breaker open until cooldown, then one probe call (half-open) decides |

State is kept **globally and per consumer**. A call is served by Jev only if both the global
state and its consumer's state are `on`.

Precedence (each level): env `JEV_KIT=on|off` (global) / `JEV_KIT_<CONSUMER>=on|off` > state file > default `on`.
State file: `$XDG_STATE_HOME/jev-kit/state.json` (default `~/.local/state/jev-kit/`), re-read per call
(cheap, and it makes the switch cross-process: a CLI `disable` also stops the pi extension).
Commands: `jev status | enable | disable [--for <dur>] | reset`, each with an optional
`--consumer <name>` (omitted = global).

### Automatic trip triggers (thresholds in `~/.config/jev-kit/config.json`)

Breaker and budgets are evaluated **per consumer**; a global cap can also be set.

- **Availability:** N consecutive failures (5xx, timeout, connection, auth) after SDK retries; sustained 429s.
- **Cost:** budget caps — tokens per day / requests per hour, from a usage ledger
  (`usage.jsonl`, one line per call with its `consumer`, fed by the response `usage` field). Budgets are in **tokens, not currency**
  (no pricing in the API docs); a token→cost multiplier can be added later.
- **Latency** (optional): p95 over a window above a ceiling.

### Preflight: `check`

`check(consumer)` / `jev check [--consumer x]` — **local and free** (no network, no tokens):
reports whether a call would be served *right now* (switch, breaker, budget, key present), with the
reason if not. Use it to skip expensive preparation in the caller (e.g. captioning a photo before
asking Jev). It is an optimisation, not a guarantee: state can change before the call, so the call
itself must still be handled when it is not served. `check` never consumes the half-open probe.
(A live `check --live` ping is deliberately not built; add it when something needs it.)

### Result

`ask()` returns one of two shapes; the caller branches on `ok`. On a TypeScript call site, checking
`if (!r.ok)` is what gives access to the right fields.

```jsonc
// Jev served the call. `answers`, `model`, `usage` are Jev's own, with one rename (below).
{ "ok": true, "consumer": "isa", "model": "jev-1.13.0",
  "answers": {
    "u": { "type": "noul",   "answer": 0.95 },
    "d": { "type": "choice", "answer": "billing", "probabilities": {…}, "confidence": 0.93 },
    "f": { "type": "score",  "answer": 1.05, "legend": {…}, "probabilities": {…}, "confidence": 0.92 } },
  "usage": { "input_tokens": 296, "output_tokens": 20 } }

// Jev did not serve it — not an error; the caller does its own thing
{ "ok": false, "consumer": "isa",
  "unavailable": { "reason": "disabled" | "tripped" | "budget" | "error" | "auth" | "credit" | "no_key", "detail": "…" } }
```

Only caller bugs are **thrown** (`JevKitError` `invalid_input`: bad questions, non-text state, a
400/422 from Jev). Unavailability is a normal state, so it is returned, never thrown.

**Official types, one rename** (full table and update checklist: [docs/JEV-MAPPING.md](docs/JEV-MAPPING.md)). Requests are the official payload (`state`, `questions`, optional
`model`) plus jev-kit's `consumer`. In answers, the value field named after the type
(`noul` | `choice` | `score`) is called `answer`; everything else is Jev's, nothing added or
dropped. So a field absent in the API is absent here (noul has no `confidence`). `model` is the
versioned id that answered: log it, it tells you when the `jev-latest` alias moved.

### CLI

Served → JSON on stdout, exit `0`. Not served → the `ok:false` JSON on **stdout** and a non-zero
exit, so shell callers can `jev run x < in.json || my-heuristic`:

| Exit | Meaning |
|---|---|
| `0` | served |
| `2` | invalid input (JSON on stderr) |
| `3` | auth: key rejected, or none configured |
| `4` | unavailable: disabled, tripped, out of credit (`credit`), or the call failed |
| `5` | budget reached |

## Decisions

Taken up front: Node/TS, no MCP, CLI + in-process library, generic core, presets external to
the repo, file-based shared state, token budgets, one key per consumer with kit-side
per-consumer budgets/breaker/kill switch. Taken after review: **no built-in fallback** (was
`abstain | static | exec | error`), unavailability is returned, plus a local `check`.

Open points, settled at implementation (all reversible):
1. **Preset format: JSON.** Portable and validated by core. `state.template` (`{{path.to.field}}`,
   `{{.}}` = whole input) covers simple state building; anything richer builds `state` in the
   consumer's code and calls `core` directly.
2. **Keys:** env and `keys.json` both work, resolution order as above. Per-key usage/limits in
   the TypeSafe console: **not checked** — the kit's own per-consumer ledger doesn't depend on it.
3. **Defaults:** breaker trips after 5 consecutive failures, 60s cooldown, then one probe. **No
   budget by default** (unlimited) — set `budget` / `consumers.<name>` in `config.json`. p95
   latency rule off by default. Windows are rolling (24h tokens, 1h requests).
4. **Cache: not implemented.** Add later, keyed by (preset version, state, question).
5. **Distribution:** `bin` in `package.json` (`npm link` in the repo, or `mise use -g npm:<path>`).

### Behaviors the sections above left open

- Breaker is **per consumer only**. The global scope has the manual switch and global budget caps.
- Auth failure (401/403) trips that consumer immediately (`auth`); a *missing* key is `no_key`
  and does not touch state. Out of credit (402, or an error whose text mentions credit/balance/
  billing/payment) is `credit`: it trips that consumer at once, the detail says "top up TypeSafe
  credits, then `jev reset`", and the usual cooldown probe still runs. A 400/422 is a caller bug: `invalid_input`, thrown, no trip.
- Env `JEV_KIT=on` overrides a manual `off`, **not** an open breaker. `jev enable` clears manual
  off and the breaker; `jev reset` clears only the breaker.
- Budgets are checked before the call from the ledger, so a call can overshoot the cap by one request.
- `askBatch` (library) merges requests sharing (consumer, state, model) into one Jev call; the
  group's usage is reported on its first request.
- State file writes are atomic but last-write-wins across processes (advisory, not a lock).

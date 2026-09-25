# Jev ⇄ jev-kit mapping

Every difference between the official Jev API and what jev-kit accepts or returns, in one place.
**All of it is implemented in [`core/wire.ts`](../core/wire.ts)** — nothing else in the repo knows
Jev's wire format. Tested by [`test/wire.test.ts`](../test/wire.test.ts), whose fixtures are copied
from the official docs.

Sources of truth: [API reference](https://docs.typesafe.ai/api.md) ·
[Models](https://docs.typesafe.ai/models.md) · [JS SDK](https://docs.typesafe.ai/sdk/javascript.md)
(pinned `^0.6.0`) · index: <https://docs.typesafe.ai/llms.txt>.

**Principle:** official types in, official types out. Requests are the official payload; answers are
Jev's, with **one rename**. Everything else jev-kit adds is *around* the call, never inside Jev's data.

## 1. Request (jev-kit → Jev)

`POST /v1/systemone` body is `{ state, model, questions }`. jev-kit sends it through
`@typesafe-ai/sdk` (`client.systemOne`), which owns the HTTP call, auth header and retries.

| Field | jev-kit input | Sent to Jev | Difference |
|---|---|---|---|
| `state` | `state` (`ask`) · the input, or `state.template` applied to it (`run`) | `state` | **Verbatim** for `ask`. Must be a string, object or array (checked locally). A preset's `state.template` (`{{path}}` substitution) is jev-kit-only sugar that yields a **string**. |
| `questions` | `questions` (`ask`) · the preset's `questions` (`run`) | `questions` | **Verbatim.** Same `{ type, instructions, criteria }` objects as the API. Checked locally against the documented limits only (see §4). |
| `model` | `model` (`ask` body) · preset `model` · `config.json` `model` | `model` | Precedence **request > preset > config > omitted**. Omitted → the SDK sends `jev-latest`. |
| — | `consumer` (`--consumer`, `ask` body, preset) | *not sent* | jev-kit-only: picks API key, breaker, budget, switch, ledger. |
| — | `preset` (label, set by `run`) | *not sent* | Ledger label only. |
| — | `signal`, `timeoutMs` (library) | *not sent* | Passed to the SDK as request options (abort / timeout), not in the body. |
| — | unknown keys in an `ask` body | *ignored* | Only `state`, `questions`, `consumer`, `model` are read. |

Not exposed at all: SDK client options other than timeout / `maxRetries` (`config.json`), custom
headers, `baseURL` (env `TYPESAFE_BASE_URL` is read by the SDK; used by the tests).

## 2. Response (Jev → jev-kit)

Served call, Jev's response `{ model, answers, usage }` becomes:

```jsonc
{ "ok": true, "consumer": "isa",        // ok, consumer: jev-kit's
  "model": "jev-1.13.0",                // Jev's, verbatim
  "answers": { "<id>": { … } },         // Jev's, with the ONE rename below
  "usage": { "input_tokens": 296, "output_tokens": 20 } }   // Jev's, verbatim
```

### The one rename

In each answer, the value field **named after the type** is renamed to `answer`. All other fields
are copied untouched, and none is added — a field absent from the API is absent here.

| Type | Jev answer | jev-kit answer |
|---|---|---|
| `noul` | `{"type":"noul","noul":0.95}` | `{"type":"noul","answer":0.95}` |
| `choice` | `{"type":"choice","choice":"billing","probabilities":{…},"confidence":0.81}` | `{"type":"choice","answer":"billing","probabilities":{…},"confidence":0.81}` |
| `score` | `{"type":"score","score":1.05,"legend":{…},"probabilities":{…},"confidence":0.92}` | `{"type":"score","answer":1.05,"legend":{…},"probabilities":{…},"confidence":0.92}` |

Consequences to remember: noul has **no `confidence`** (the API gives none; it is absent, not `null`).
The rename is generic (`{[type]: value, ...rest}`), so a future answer type whose value field is named
after its `type`, or new extra fields on existing types, pass through with **no code change**.

## 3. Not served (jev-kit-only)

Jev being off, tripped, over budget or failing is jev-kit's concept, not the API's. The result is
`{ "ok": false, "consumer", "unavailable": { "reason", "detail" } }`. jev-kit **never** produces
substitute answers. Reasons and how they arise:

| `reason` | Cause | From Jev? |
|---|---|---|
| `disabled` | `jev disable` / `JEV_KIT=off` | no |
| `tripped` | breaker open (N consecutive failures, or p95 latency) | no |
| `budget` | token / request cap reached (from the local ledger) | no |
| `no_key` | no API key resolved for the consumer | no |
| `error` | 429 (after SDK retries), 5xx / 529, timeout, connection error | yes |
| `auth` | 401 / 403 | yes |

## 4. Errors and limits

| Jev / SDK | jev-kit | Breaker |
|---|---|---|
| `422 Unprocessable Entity`, `400` (`UnprocessableEntityError`, `BadRequestError`) | **thrown** `JevKitError` `invalid_input` (CLI exit 2) | not counted |
| `401` / `403` (`AuthenticationError`, `PermissionDeniedError`) | returned, `reason: "auth"` (exit 3) | trips that consumer at once |
| `429`, `5xx`, `529`, timeout, connection (`RateLimitError`, `InternalServerError`, `APIConnectionError`, …) | returned, `reason: "error"` (exit 4) | counts toward N failures |
| user abort (`APIUserAbortError`) | rethrown as is | not counted |

Local pre-validation (`validateQuestions`, `assertState`) is **intentionally shallow** so the docs, not
jev-kit, define what's valid: only the three known types, choice 1–255 options, score 2–10 levels,
state is string/object/array. Everything subtler is left to Jev and comes back as a 422.

Documented limits that jev-kit does **not** check: 64k tokens per request, 32k for `state` + the
longest question (an oversized request comes back as 400/422 → `invalid_input`); rate limits
(1,200 req/min, 250k tok/s — handled by SDK retries, then `error`).

## 5. When the API evolves — what to change

Start by updating the docs fixtures in `test/wire.test.ts` from the API reference; the failures show
the impact. Then:

| Change in Jev | Do this |
|---|---|
| **New answer type** (value field named after `type`) | Nothing for the rename. Add a `case` in `validateQuestions` for its question type. Add the type to `Answer["type"]` in `core/types.ts`. |
| **New answer type with a different value-field name** | Special-case it in `fromJevAnswers`. |
| **New field on an existing answer / response** | Nothing (passed through). If it should be typed, add it to `Answer` / `Served` in `core/types.ts`. |
| **Renamed or removed answer field** | Nothing in `fromJevAnswers` (still verbatim). Update `Answer` in `core/types.ts`, the hook helper (`adapters/claude/hook.ts` reads `answer`/`confidence`), and §2 here. |
| **New request field** (e.g. a per-request option) | Add it to `AskRequest` (`core/types.ts`) and to `toJevRequest`. If the CLI should expose it, read it in `cli/jev.ts` (`ask` body / preset). |
| **New question field** | Nothing (questions are passed verbatim). |
| **New limits** (options, levels, context) | Update the constants in `validateQuestions`. |
| **New / changed HTTP status** | Update `classifyError`, then §4 here. |
| **New model / alias** | Nothing. Set `model` in a preset or `config.json`. Pin a versioned id if you tuned thresholds (the response's `model` tells you which version answered). |
| **SDK major upgrade** | `npm install @typesafe-ai/sdk@latest`, `npm test && npm run typecheck`. Only `core/wire.ts` and the `TypeSafeClient` construction in `core/ask.ts` import from the SDK. |

Surfaces that describe the output shape and must be kept in sync by hand: `DESIGN.md` (Result),
`adapters/claude/skills/jev/SKILL.md`, and this file.

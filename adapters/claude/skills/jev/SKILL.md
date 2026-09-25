---
name: jev
description: Ask Jev (TypeSafe System One) typed questions — yes/no probability, pick-one, ordered score — about a piece of text or JSON via the `jev` CLI. Use for fast routing, classification, selection or verification judgments where confidence matters; also to check or flip the shared jev on/off switch.
---

# jev

`jev` returns calibrated, typed judgments over **text-only** state. It is not a chat model:
give it state and questions, get structured answers. Batch every question about the same state
into one call — the state is read once and questions run in parallel.

## Ad-hoc

```sh
echo '{
  "state": "Help! My payouts have been failing for 3 days.",
  "questions": {
    "is_urgent":   {"type":"noul",   "instructions":"Does this convey urgency?"},
    "department":  {"type":"choice", "instructions":"Which team?", "criteria":{"billing":"payments, refunds","technical":"bugs, outages"}},
    "frustration": {"type":"score",  "instructions":"How frustrated?", "criteria":["Calm","Frustrated","Very angry"]}
  }
}' | jev ask --consumer <name>
```

Presets (saved question sets): `jev presets`, then `jev run <preset> --in state.json` (or `--text` with a raw-text stdin).

## Reading the result

Served (exit 0):
```json
{"ok":true,"consumer":"x","model":"jev-1.13.0","answers":{"department":{"type":"choice","answer":"billing","probabilities":{…},"confidence":0.81}},"usage":{…}}
```
Not served (non-zero exit, same JSON shape on **stdout**):
```json
{"ok":false,"consumer":"x","unavailable":{"reason":"disabled","detail":"…"}}
```

- **`ok:false` is not an error and jev never guesses for you.** Do the task without Jev (your own logic, or ask the user). Do not invent the answers, and do not re-enable Jev to get around it.
- Reasons: `disabled` · `tripped` (breaker) · `budget` · `error` · `auth` · `no_key`. Exit: `0` served · `2` invalid input (stderr) · `3` auth/no key · `4` unavailable · `5` budget.
- `jev check [--consumer x]` is a free local preflight (no network): use it before expensive prep work. It is not a guarantee — still handle `ok:false` on the call.
- Answers are Jev's official ones, with the value field (`noul`/`choice`/`score`) renamed `answer`. noul: P(yes) in [0,1], no `confidence` field. choice/score: `probabilities` and `confidence` (score also `legend`). Gate actions on confidence, not just the answer.

## Switch

`jev status` · `jev disable [--for 2h]` · `jev enable` · `jev reset` (clears the breaker). Add `--consumer <name>` to scope; omit for global. `JEV_KIT=off` in the environment also disables. Don't disable it on your own initiative.

## Limits

Text/JSON only (no images — caption first). 64k tokens per request, 32k for state + the longest question. Choice ≤ 255 options, Score 2–10 levels.

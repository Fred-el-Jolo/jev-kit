---
task: "Review the credit-reason todo against the code"
slug: 20261003-180919_review-todo-credit
effort: E1
phase: complete
progress: 3/3
started: 2026-10-03T18:09:19
updated: 2026-10-03T18:10:06
root: .
stated_goal: "enc:v1:0ddf368a:QaJxDKVx_yM7Q7mTskz_UmX4LLpaDeRlHlG1nlcffX1DGdQWaCrYTDXZQhjfYGVWkhAVSDe0gpqk8tc9_ZFqRVq53T5P1eNiPw"
stated_goal_source: prompt
asks: ["enc:v1:0ddf368a:U92VhPkaRFP1O2dgCZJXs6Ln6gcQcs8f4Tym4i8ug7BY2BdIMriFNUzJHR3GAyUfsbY", "enc:v1:0ddf368a:YbMo919H3s-pbufp78xhMbZjPNtMufukvYRliFdj2vHur9AUE-3OHxYPiAPLz7L166HHFqdBmbo"]
context_sufficient: true
---

## Goal

"enc:v1:0ddf368a:smsPQIj1fhFq7knhiuODQettKZVgTrr-mBq7sK4cCmQtdUZkxKeBHoC3lCFRdBQKqWa3arAX-Ww1yZcHUa1HgiEzJNQ-dFk" — check each item of todo.md against the current jev-kit code, the SDK and the ISA consumer, and report the gaps, contradictions and missing decisions, without changing any project file.

## Criteria

- [x] ISC-1: Every todo item is checked against the code it touches.
- [x] ISC-2: Each finding cites the file and line that supports it.
- [x] ISC-3: Anti: No tracked project file is modified by this review.

## Test Strategy

```yaml
- isc: ISC-1
  anchors_to: "enc:v1:0ddf368a:U92VhPkaRFP1O2dgCZJXs6Ln6gcQcs8f4Tym4i8ug7BY2BdIMriFNUzJHR3GAyUfsbY"
  type: manual
  kind: decision
  check: findings cover all five checklist items of todo.md
  threshold: five of five
  tool: attest
- isc: ISC-2
  anchors_to: "enc:v1:0ddf368a:YbMo919H3s-pbufp78xhMbZjPNtMufukvYRliFdj2vHur9AUE-3OHxYPiAPLz7L166HHFqdBmbo"
  type: manual
  kind: decision
  check: each finding names a file:line or doc line
  threshold: all findings
  tool: attest
- isc: ISC-3
  anchors_to: "enc:v1:0ddf368a:U92VhPkaRFP1O2dgCZJXs6Ln6gcQcs8f4Tym4i8ug7BY2BdIMriFNUzJHR3GAyUfsbY"
  type: mechanical
  kind: file
  check: no diff in tracked project files
  threshold: exit 0
  tool: git diff --quiet HEAD -- core cli test adapters DESIGN.md docs README.md
  fails-when: "git diff lists a change under core, cli, test, adapters or the docs"
```

## Verification

- ISC-1: attested 2026-10-03T18:09:52 — all 5 todo items traced: classifyError wire.ts, recordFailure/hasProbeWindow state.ts, gate ask.ts, exitCodeFor types.ts:100, test helpers mock (ledger: acbbc34972)
- ISC-2: attested 2026-10-03T18:09:52 — findings cite core/state.ts hasProbeWindow, core/ask.ts gate+execute, core/types.ts:98-103, SDK index.mjs:78-198, jolo-isa runtime/isa/jev.py:85,106, docs exceptions page (ledger: 82cee5b92f)
- ISC-3: verified 2026-10-03T18:10:06 — exit 0 in 0.0s — `git diff --quiet HEAD -- core cli test adapters DESIGN.md docs README.md` (ledger: 067dd05cd4)
- Ask 1: met — each of the five checklist items traced to wire.ts, state.ts, ask.ts, types.ts, the SDK and jev.py
- Ask 2: met — findings reported in the final answer, ranked by impact
- Goal: yes — review delivered with code-cited findings; no project file changed

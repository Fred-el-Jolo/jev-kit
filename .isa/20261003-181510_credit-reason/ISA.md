---
task: "Add a minimal credit unavailable reason"
slug: 20261003-181510_credit-reason
effort: E2
phase: complete
progress: 6/6
started: 2026-10-03T18:15:10
updated: 2026-10-03T18:16:37
root: .
stated_goal: "enc:v1:0ddf368a:Iy9QxMIPEwDunGGtrL0-hlBSjsslb6vREQvhCxbvudY2bFa6IdJ7ROYCtvOjaV2bLOoiBffqy6KKk1AiKLq1DqfIYXHIgJsXoNYC2AUq5RFzLPX4"
stated_goal_source: prompt
asks: ["enc:v1:0ddf368a:k5ASat8bdkF4jd0cn028Bzl5R6x5mqiKGXMsyNBa1bKSpH21AUv63TPozLoW0PNDLB0jVRE", "enc:v1:0ddf368a:Iy9QxMIPEwDunGGtrL0-hlBSjsslb6vREQvhCxbvudY2bFa6IdJ7ROYCtvOjaV2bLOoiBffqy6KKk1AiKLq1DqfIYXHIgJsXoNYC2AUq5RFzLPX4"]
context_sufficient: true
---

## Problem

Out-of-credit responses show up as `error` (402) or `auth` (403), so callers must regex `detail` and pay 5 failed calls first.

## Out of Scope

Dropped as too complex: stay-tripped-until-reset and its config switch, a stored trip kind in the breaker, retry tuning for credit-worded 429s, capturing a real exhausted-account response first.

## Goal

"enc:v1:0ddf368a:QZQbtc6TxNNibvDncL2Wqf3hvGsR-j5p3Aq2kQKSe20Pfb6PdDnuaQQTe8mALPBSd1oKEsyNSyaWAuZS-Cfr-1X82WP3dI3vrjE_19RZHDXeaA" — a `credit` reason for 402 and credit-worded errors, an immediate trip with the normal cooldown probe, a top-up hint in the tripped detail, exit 4, docs updated.

## Criteria

- [x] ISC-1: classifyError maps 402 and credit-worded 401/403/429 errors to credit.
- [x] ISC-2: A 402 trips the consumer at once with a top-up hint.
- [x] ISC-3: The CLI exit code for a credit reason is 4.
- [x] ISC-4: Anti: A plain 403 without credit wording still maps to auth.
- [x] ISC-5: DESIGN, JEV-MAPPING and the jev skill list the credit reason.
- [x] ISC-6: Anti: The full test suite still passes after the change.

## Test Strategy

```yaml
- isc: ISC-1
  anchors_to: "enc:v1:0ddf368a:Iy9QxMIPEwDunGGtrL0-hlBSjsslb6vREQvhCxbvudY2bFa6IdJ7ROYCtvOjaV2bLOoiBffqy6KKk1AiKLq1DqfIYXHIgJsXoNYC2AUq5RFzLPX4"
  type: mechanical
  kind: behaviour
  check: wire test for credit classification passes
  threshold: exit 0
  tool: node --test --test-name-pattern="credit classification" test/wire.test.ts
- isc: ISC-2
  anchors_to: "enc:v1:0ddf368a:Iy9QxMIPEwDunGGtrL0-hlBSjsslb6vREQvhCxbvudY2bFa6IdJ7ROYCtvOjaV2bLOoiBffqy6KKk1AiKLq1DqfIYXHIgJsXoNYC2AUq5RFzLPX4"
  type: mechanical
  kind: behaviour
  check: core test for 402 immediate trip passes
  threshold: exit 0
  tool: node --test --test-name-pattern="402 → credit" test/core.test.ts
- isc: ISC-3
  anchors_to: "enc:v1:0ddf368a:Iy9QxMIPEwDunGGtrL0-hlBSjsslb6vREQvhCxbvudY2bFa6IdJ7ROYCtvOjaV2bLOoiBffqy6KKk1AiKLq1DqfIYXHIgJsXoNYC2AUq5RFzLPX4"
  type: mechanical
  kind: behaviour
  check: exitCodeFor credit is 4
  threshold: exit 0
  tool: node -e "import('./core/types.ts').then(m=>process.exit(m.exitCodeFor({reason:'credit',detail:''})===4&&m.EXIT_CODES.unavailable===4?0:1))"
  fails-when: "exitCodeFor returns 3 or 5 for credit"
  red: exempt — credit already falls through to 4 before the change
- isc: ISC-4
  anchors_to: "enc:v1:0ddf368a:Iy9QxMIPEwDunGGtrL0-hlBSjsslb6vREQvhCxbvudY2bFa6IdJ7ROYCtvOjaV2bLOoiBffqy6KKk1AiKLq1DqfIYXHIgJsXoNYC2AUq5RFzLPX4"
  type: mechanical
  kind: regression
  check: existing classifyError test (plain 403 → auth) passes
  threshold: exit 0
  tool: node --test --test-name-pattern="maps SDK errors" test/wire.test.ts
  fails-when: "a bare 403 is classified as credit or error"
- isc: ISC-5
  anchors_to: "enc:v1:0ddf368a:Iy9QxMIPEwDunGGtrL0-hlBSjsslb6vREQvhCxbvudY2bFa6IdJ7ROYCtvOjaV2bLOoiBffqy6KKk1AiKLq1DqfIYXHIgJsXoNYC2AUq5RFzLPX4"
  type: mechanical
  kind: doc
  check: credit appears in the three docs
  threshold: exit 0
  tool: grep -q '`credit`' DESIGN.md && grep -q '`credit`' docs/JEV-MAPPING.md && grep -q '`credit`' adapters/claude/skills/jev/SKILL.md
  fails-when: "one of the three files has no credit entry"
- isc: ISC-6
  anchors_to: "enc:v1:0ddf368a:Iy9QxMIPEwDunGGtrL0-hlBSjsslb6vREQvhCxbvudY2bFa6IdJ7ROYCtvOjaV2bLOoiBffqy6KKk1AiKLq1DqfIYXHIgJsXoNYC2AUq5RFzLPX4"
  type: mechanical
  kind: regression
  check: npm test passes
  threshold: exit 0
  tool: npm test
  fails-when: "npm test exits non-zero"
```

## Decisions

- 2026-10-03: keep the normal 60 s cooldown probe for credit (a 402 probe is cheap and recovers automatically after a top-up); the hint lives in the breaker reason string, so status/check show it with no new state.

## Verification

- ISC-1: verified 2026-10-03T18:16:37 — exit 0 in 0.19s — `node --test --test-name-pattern="credit classification" test/wire.test.ts` (ledger: cda4607f51)
- ISC-2: verified 2026-10-03T18:16:37 — exit 0 in 0.25s — `node --test --test-name-pattern="402 → credit" test/core.test.ts` (ledger: 10d954b4c8)
- ISC-3: verified 2026-10-03T18:16:37 — exit 0 in 0.08s — `node -e "import('./core/types.ts').then(m=>process.exit(m.exitCodeFor({reason:'credit',detail:''})===4&&m.EXIT_CODES.unavailable===4?0:1))"` (ledger: afcee235d8)
- ISC-4: verified 2026-10-03T18:16:37 — exit 0 in 0.2s — `node --test --test-name-pattern="maps SDK errors" test/wire.test.ts` (ledger: 196c907b71)
- ISC-5: verified 2026-10-03T18:16:37 — exit 0 in 0.01s — `grep -q '`credit`' DESIGN.md && grep -q '`credit`' docs/JEV-MAPPING.md && grep -q '`credit`' adapters/claude/skills/jev/SKILL.md` (ledger: 35c1b5c5c1)
- ISC-6: verified 2026-10-03T18:16:37 — exit 0 in 2.91s — `npm test` (ledger: f6d7cf7a7a)
- Ask 1: met — yes, achievable once stay-tripped, stored trip kind and retry tuning are dropped
- Ask 2: met — implemented in ~10 lines of code across wire.ts, ask.ts, types.ts plus tests and docs; dropped parts listed in todo.md
- Goal: yes — credit reason works end to end (402 → credit, immediate trip, top-up hint, exit 4) with nothing complex added

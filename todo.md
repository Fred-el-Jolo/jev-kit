# TODO

## Out-of-credit as its own reason — done (minimal)

`credit` reason for 402 or credit-worded errors, immediate trip, top-up hint in the detail, exit 4.

Dropped as not worth the complexity (revisit only if needed):
- [ ] Match the real exhausted-account response once one is seen (today: 402 + wording regex in `core/wire.ts`).
- [ ] Stay tripped until `jev reset` instead of the 60 s cooldown probe.

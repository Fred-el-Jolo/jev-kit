# jev-kit

Generic wrapper around Jev (TypeSafe System One) for pi, Claude Code and local scripts/apps.
Includes a shared enable/disable switch, breaker and budgets. It never answers in Jev's place:
when Jev can't serve a call it says so, and each caller runs its own fallback.
See [DESIGN.md](DESIGN.md).

```sh
mise install && npm install && npm link       # `jev` on PATH
export TYPESAFE_API_KEY=…                     # or TYPESAFE_API_KEY_<CONSUMER>, or ~/.config/jev-kit/keys.json

jev presets
echo "Help! Payouts failing for 3 days." | jev run urgency --text --consumer demo
jev check --consumer demo                     # local preflight: would a call be served now?
jev disable --for 2h && jev status            # every surface honors this
jev run urgency --text < in.txt || ./my-own-heuristic   # non-zero exit when Jev didn't serve
npm test && npm run typecheck                 # mock-server tests, no API key needed
```

| Path | |
|---|---|
| `core/` | library: `ask`, `askBatch`, `check`, presets, switch/breaker/budget |
| `cli/jev.ts` | `jev run \| ask \| check \| presets \| status \| enable \| disable \| reset` |
| `adapters/pi/` | pi extension (`pi -e adapters/pi/index.ts`): `jev_ask`, `jev_run`, `/jev` |
| `adapters/claude/` | skill + `UserPromptSubmit`-style hook helper ([README](adapters/claude/README.md)) |
| `presets/` | generic examples only |

Config: `~/.config/jev-kit/config.json` — `{ "budget": { "tokensPerDay": 500000 }, "consumers": { "isa": { "requestsPerHour": 600 } }, "breaker": { "failures": 5, "cooldownMs": 60000 } }`.

MIT — see [LICENSE](LICENSE). Not affiliated with TypeSafe; "Jev" and "System One" belong to their owners.

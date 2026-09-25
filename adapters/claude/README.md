# Claude Code adapter

**Skill** — teaches Claude the `jev` CLI:

```sh
ln -s "$PWD/skills/jev" ~/.claude/skills/jev      # needs `jev` on PATH: `npm link` in the repo root
```

**Hook** — run a preset on every prompt and inject the answers as context. Never blocks; silent (exit 0, no output) when Jev is unavailable — the agent just proceeds without it.

```jsonc
// ~/.claude/settings.json
{ "hooks": { "UserPromptSubmit": [{ "hooks": [{
  "type": "command",
  "command": "node /path/to/jev-kit/adapters/claude/hook.ts --preset <name> --consumer <name> --field prompt"
}] }] } }
```

`--field prompt` picks the hook payload's `prompt` as state (default: whole payload). 

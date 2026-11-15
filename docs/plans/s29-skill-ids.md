# S-29: inventory ids that collide across platforms

## The bug
`collectInventory` ends with a dedup by id; a Codex and a Claude Code file at the same
relative place share an id, so the Claude Code one is dropped (pilot j4th_mtg-mcp-server: 3 skills).

## Collisions found (by reading classify / classifyCodex / codexItems)
| id kind | Codex side | Claude Code side |
|---|---|---|
| `skill:X`, `skill-file:X/..`, `skill-dir:X/..` | `.agents/skills/X/` | `.claude/skills/X/` |
| `agent:X` | `.codex/agents/X.toml` | `.claude/agents/X.md` |
| `rule:X` | `.codex/rules/X.rules` | `.claude/rules/X.md` |
| `hook:<event>[m] <cmd>` | `.codex/hooks.json` | `.claude/settings.json` |
| `mcp:X` | `.codex/config.toml` | `.mcp.json` |
| `hook:...` (same platform) | | `.claude/settings.json` and `settings.local.json` |
No collision: `config:` (Codex is `config:codex/..`, AGENTS.md is `config:AGENTS.md`,
CLAUDE.md is not collected), `claude-file:` (Codex keeps its `.codex/` prefix), `user:*`.

## The id choice: qualify only on collision
1. Items with the same id AND the same path are one item (kept once, as before).
2. Ids still shared by items at different paths: the item under `.codex/` or
   `.agents/` becomes `codex:<id>`. The Claude Code item keeps the bare id.
3. Ids still shared after that (same platform, e.g. a hook in settings.json and
   settings.local.json): the first keeps the bare id, each later one becomes
   `<id> @<path>`.
A project with one platform's files sees no id change: every existing pin and
saved inventory.json keeps working. A saved inventory.json from before S-29 (one
`skill:X`, the Codex path) still loads: coverage of files maps by path, not id.

## Coverage and the target
`coverage` takes no target: it already maps against what both claude-code and
codex scaffold would write. So a .at skill `X` maps `.claude/skills/X/**` and
`.agents/skills/X/**` both; each is counted as its own item. Id-parsing in
`isMapped` (hook, mcp-server, mcp-tool, script) reads the bare id (prefix and
`@path` suffix stripped).

## Done when Red-first fixture with both folders (skill, agent, rule, hook, mcp) keeps every
item, each with its own path; coverage maps both; an old inventory.json loads;
tsc clean; vitest green; pilot before/after per repo.

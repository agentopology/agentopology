# S-36: only Markdown files under .claude/commands are commands

## The rule (Claude Code docs, https://code.claude.com/docs/en/slash-commands, fetched 2026-11-15)

> **Command files**: a Markdown file in `.claude/commands/` is the older format and still works.

> | File under `.claude/commands/` | File name without extension | `.claude/commands/deploy.md` → `/deploy` |
> | File in a subdirectory of `.claude/commands/` | Subdirectory path relative to `commands/` with each `/` replaced by `:`, then the file name without extension | `.claude/commands/frontend/component.md` → `/frontend:component` |

## What changes

- `inventory` lists a file under `.claude/commands/` (any depth) as `command:<name>` only when it ends in `.md`.
- Any other file there (`manifest.json`, a script) is listed as `claude-file:commands/<path>`, like any other file under `.claude`.
- The same holds for `~/.claude/commands` with `--user` (`user:command:` vs `user:claude-file:`).
- The importer already reads only `.md` command files (`src/import/claude-code.ts`, step 5); inventory now agrees with it.

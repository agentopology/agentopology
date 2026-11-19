# Changelog

All notable changes to agentopology are documented here.

## [0.12.4] - 2026-11-19

### Changed behaviour

- `guard --check` no longer counts a gate as refusing because it cites code. A gate that cites the code refusing it (`at:`) grades `refuse` only through its own generated hook: the hook `guard --target` or `scaffold` writes from the gate's `run:`. Otherwise it grades `cited`, a new grade, and is not counted as refusing. No other hook counts for a cited gate: not a hand-written hook in `.claude/settings.json`, not a CI workflow, not a hook declared in `hooks { }` and cited on the gate's edge with `[guard: name]`, and not another gate cited there. The enforcement line counts citations apart: a project whose eight gates all cite code with no generated hook now reads `enforcement: 0 of 8 steps refuse (8 cited, 0 wired, 0 proven)`, where it read `8 of 8 steps refuse`, and a line after it says how to make a cited gate count: give the gate a `run:` and let `guard --target` write its hook. `wired` counts cited gates their generated hook makes refuse; `guard --check` never runs cited code, so `proven` is 0.
- An advisory gate (`behavior: advisory`) that cites code is no longer graded `refuse` by its citation: it grades `cited`.
- A gate credited through another gate (`[guard: <gate>]`, "as strong as gate …") follows that gate's grade as before, so a gate credited only through a cited gate is no longer `refuse` either.
- On Codex, `guard --check --target codex` grades a holding citation with no hook of its own `cited`, as on Claude Code; it read `unverified`.
- The guard facts the visualizer page reads can carry the grade `cited`, drawn as a gray hollow circle, and the page's headline counts it.

## [0.12.3] - 2026-11-17

### Changed behaviour

- `scaffold` no longer widens a capability key in an agent, skill or command file over a value it did not write. When the file's value is not one scaffold applied (nothing recorded yet, or the file changed it since) and the .at's value grants more, the file's value is kept and one line says what the .at would add, such as `! .claude/agents/scout.md: tools kept as written: the .at would widen them (+mcp__playwright__*); --force applies the .at's`, and `validate --inventory` lists it as drift with state `kept-narrower`. Only `--force` writes the .at's value. The keys are an agent's `tools`, `disallowedTools`, `mcpServers` and `permissionMode`, and a skill's or command's `allowed-tools` and `disallowed-tools`. A tool list is wider when the .at names a tool none of the file's entries covers: a server wildcard covers that server's tools (`mcp__playwright__*` covers `mcp__playwright__browser_click`), `mcp__*` covers every MCP tool, a bare tool covers its parameterised forms (`Bash` covers `Bash(git log:*)`), and an agent with no `tools`, or with `tools: "*"`, already has every tool, so an .at that narrows it to a list is written. A denylist is wider when the .at stops denying a tool the file denies. Permission modes rank `dontAsk` < `default` < `acceptEdits` < `auto` < `bypassPermissions`, with `plan` below `auto` only; `plan` against `default`, a mode over an agent that names none (it inherits the session's) other than `dontAsk`, and any value that cannot be compared count as wider. Before, a hand-narrowed list of four playwright tools came out as `mcp__playwright__*` on the first run, with only a change line. Narrowing (removing a tool, adding a denial, lowering a mode) is written as before, and so is a widening of a value scaffold itself applied and the file still holds.
- After `import`, an edit to the .at that adds a tool to an agent's `tools` or a skill's or command's `allowed-tools` is not written into the imported file on the next `scaffold`: import records nothing, so scaffold did not write the file's value, and the added tool is kept out and reported as `! <file>: tools kept as written: the .at would widen them (+<tool>); --force applies the .at's`. Run `scaffold --force` to write it. Edits that remove a tool, or change a key that grants nothing (model, description), are written as before. The added tool is kept until a scaffold run has recorded that key's value (a run where the .at and the file agree); after that the .at owns the key and its edits apply.

### Fixed

- A scaffold manifest (`.claude/.scaffold-manifest.json`) that scaffold cannot read, such as `files` that is not an object, a file entry with no hash, or a recorded frontmatter value that is null, a number or an object, stops `scaffold`, `guard --target` and `validate --inventory` with one line naming the file and what is wrong, as `Error: .claude/.scaffold-manifest.json is not a scaffold manifest this version can read: fields[".claude/agents/builder.md"].tools is not a frontmatter value.`, and exit 1. Before, most of these crashed with a TypeError stack and the rest were read as something else. A manifest that is not JSON is still read as none, as before.
- Twelve keys the Claude Code settings reference scopes to `Global config` (`~/.claude.json`) are no longer listed as settings keys: `autoConnectIde`, `autoInstallIdeExtension`, `claudeInChromeDefaultEnabled`, `copyFullResponse`, `copyOnSelect`, `defaultToAgentsView`, `diffTool`, `externalEditorContext`, `leftArrowOpensAgents`, `prStatusFooterEnabled`, `permissionExplainerEnabled` and `teammateDefaultModel`. Claude Code does not read them from `.claude/settings.json`, and scaffold never writes them there. Setting one in `extensions { claude-code { ... } }` is a V130 warning that names it as a `~/.claude.json` global-config key, not a project setting; before, the warning said it was read from user or managed settings. For `permissionExplainerEnabled` and `teammateDefaultModel` the warning also quotes the docs' removal line ("Setting it has no effect on current versions").
- `keybindingFlavor`, `voiceEnabled`, `includeCoAuthoredBy` and `disableArtifact`, deprecated in the settings reference but still accepted by Claude Code, are still written to `.claude/settings.json`, and V130 now warns with the docs' deprecation line and its replacement.
- `scripts/claude-code-schema-drift.mjs --write` reads each key's Scope and warning box: `Global config` keys go to their own list, never to the settings rows, and removal or deprecation lines are kept with the row. The drift check reports a changed removal or deprecation line.

## [0.12.2] - 2026-11-17

### Changed behaviour

- `permissions: interactive` no longer writes `permissionMode: acceptEdits` into the Claude Code agent file. It writes no permissionMode, so Claude Code asks, as the word is documented; `acceptEdits` approved file edits and common filesystem commands without asking. Validation warns on every `permissions: interactive` (V132) naming the old value. Write `permissions: acceptEdits` to keep the old behaviour.
- `scaffold --allow-invalid` no longer writes the whole topology as if it were valid. Each validation error is attributed to the node it names, and only the files of agents with no error are written (new files, and frontmatter updates as usual). `.claude/settings.json`, `.claude/settings.local.json`, `.mcp.json`, `.codex/hooks.json` and the other files the whole topology shares (the topology skill, rules, gate and hook scripts) are never written while any error is open, so a partial run cannot leave a hook pointing at a script that was not written or a deny rule missing. Each file held back is listed, as `⊘ .claude/agents/planner/AGENT.md (not written: node planner has validation errors)` or `⊘ .claude/settings.json (not written while validation errors are open)`. An error that names no node writes nothing at all. The command now exits 1 while errors remain, even when some files were written (it exited 0), and `--dry-run` lists the same files as the real run. Without the flag nothing changes.
- A hook's `if:` written in dotted form (`mcp.server.tool(…)`) now compiles to Claude Code's tool name; before, it was written as is and never matched, so that hook now runs. `validate` names each such hook.

### Added

- An MCP server a Claude Code plugin provides can be declared in `mcp-servers` with `from: plugin "<plugin-name>"` (and `server: "<server-name>"` when it differs from the block key). Its tool references compile to Claude Code's plugin names, `mcp__plugin_<plugin>_<server>__<tool>`, with any character outside `A-Za-z0-9_-` replaced by `_`: in agent `tools` and `disallowed-tools`, skill `allowed-tools`, `settings { allow ask deny }` and hook matchers. An `mcp_tool` hook's `server` becomes `plugin:<plugin>:<server>`. An agent's `mcp-servers` entry naming a plugin's server is left out of the agent's `mcpServers` for now, and `validate` notes it: the scoped name is not yet verified there, and the agent's tools already reach the server. No `.mcp.json` entry is written for the server. In tool lists, permission rules and a hook's `if:`, only an entry whose tool part is the server's MCP name (`mcp__<key>`, `mcp__<key>__<tool>`) is rewritten; text inside a rule's argument, such as `Read(./mcp__playwright/**)`, stays as written. A hook matcher that names the server in a form scaffold can't rewrite, such as `mcp__(playwright|x)__.*`, is a V130 warning naming the form that fires. Before, a plugin's playwright server could only be named as a project server, so `mcp.playwright.*` compiled to `mcp__playwright__*`, which matches no tool, and the agent silently had no browser tools. A server without `from` compiles as before. Codex and Cursor write no entry for a plugin's server and warn.
- Validation rule V133 (error): an `mcp-servers` entry's `from:` that is not `from: plugin "<plugin-name>"` (single quotes, `Plugin`, the whole value quoted, an empty or spaced name) stops `validate` and `scaffold` and names the expected form, where a near miss would have fallen back to a project server and silently lost the plugin's tools.
- Validation rule V132 (warning) for `permissions:` words whose Claude Code compile is not what they read as. `permissions: auto` still compiles to `permissionMode: auto` and now warns that it is Claude Code's auto mode (a classifier approves actions without asking), not `autonomous`; write `autonomous` for the session's own mode. The docs no longer call `auto` the short form of `autonomous`.
- Claude Code's own permission values `default`, `acceptEdits`, `dontAsk` and `bypassPermissions` are recognized `permissions:` values: they pass through as written, and V27 no longer warns that they are unrecognized.

### Fixed

- `import` reads an agent's `permissionMode: auto` as `permissions: auto`, not `autonomous`. `autonomous` writes no permissionMode, so an import followed by `scaffold` dropped Claude Code's auto mode from the agent file without a message; it is now written back, and validation names it (V132).

## [0.12.1] - 2026-11-17

### Security

- The generated step guard closes additional ways to reach a gated command: a helper that hands a gated tool its arguments from standard input is refused, with jq and without it. The tool counts only when it is the program the helper runs, read from each helper's own option list with letter case as written, so the helper running another program that merely names the tool still runs.

### Changed behaviour

- A topology that parses to less than its source declares now fails `validate` and `scaffold` (V131) where it used to pass with parts silently missing. If an upgrade turns a file red with V131, the message names the line where parsing stopped: balance the braces there, or move a brace out of a quoted string.

### Fixed

- Old scaffolds wrote deny rules where Claude Code doesn't read them; run `validate --inventory` to find them. agentopology 0.11.4 and earlier wrote an `extensions { claude-code { deny: [...], allow: [...] } }` list into the top level of `.claude/settings.json` as a string, and Claude Code reads permission rules only under `permissions`, so those rules refused nothing. `validate --inventory`, `guard --check` and `scaffold` now print one line per `allow`, `deny` or `ask` list found at the top level of `.claude/settings.json` or `.claude/settings.local.json`, with the rules and where they go, for example `! .claude/settings.json: "deny" at the top level is not read by Claude Code; move ["Read(./.env)"] into "permissions": { "deny": [...] }`. Move them by hand: nothing rewrites the file, and no exit code changes.
- A `{` or `}` inside a `#` comment no longer opens or closes a block. A comment such as `# }` in an agent, or a trailing `model: sonnet # see } note`, could end the topology early: every agent and the settings were dropped, `validate` still said all rules passed and `scaffold` wrote no agents and no `settings.json`, so the deny rules were silently missing. A `#` inside a quoted string, inside a prompt, or inside a word (a URL fragment) is still text, not a comment.
- A topology that parses to less than its source declares is now an error (V131), never a silent partial or empty parse. When a brace inside a quoted string, or a brace that does not balance, ends the topology or a block before its written end, `validate` and `scaffold` exit 1 and name the line where parsing stopped and the blocks that would not be read. A second copy of a section that may appear once, such as two `gates { }` blocks, stays a V23 warning (only the first copy is used) and is not reported as lost.
- `scaffold` no longer deletes a hook command of your own that names one of the topology's scripts when its first word is an interpreter or a variable, such as `bash ./wrap.sh <script>`, `STRICT=1 ./check.sh <script>`, `node tools/audit.js <script>` or `cat <script> | ./audit.sh`. It is kept, with `--force` and `--prune` too, and scaffold prints `kept a command the .at does not generate` for it, in `.claude/settings.json` and `.codex/hooks.json`. A command is the topology's only when it is the command the binding writes for one of its scripts; an edited copy of that command (an argument added, a command chained to it) is still replaced, as before.

## [0.12.0] - 2026-11-17

### Breaking

- `validate --inventory` exits 3 when the only problem is structure drift: a frontmatter key where the `.at` and the file disagree. It exited 0 before. Errors and missing files still exit 1.
- `scaffold --force` no longer replaces any file's text. It sets the frontmatter keys the `.at` states; a file you edited stays as it is. To have scaffold generate an edited file again, delete it first.
- A list that never closes, a quoted list item left open, or text after a list's `]` that is not another field is now a parse error that names the key. Before, part of the list was kept and the rest dropped without a message.
- A hook name used in two `hooks { }` blocks is now an error (V23).
- A list or field written only inside a prompt or a quoted string is no longer read as the field.
- Generated output changes where the `.at` states something Claude Code reads elsewhere: agent files no longer carry `sandbox` or `fallback-chain`, and `settings.json` gains `sandbox.enabled`, `fallbackModel` or the `permissions` keys an extension sets. Among the bundled examples, `scheduled-monitor.at` changes (three agent files lose those two lines, and `settings.json` gains `fallbackModel`); the `kitchen-sink.at` sample now sets `outputStyle` instead of a key Claude Code does not have.

### Upgrading

- Run `agentopology validate <file.at> --inventory <project-dir>` once. Each drift row names the file, the key, the `.at` value and the file's value. Make them agree: `scaffold` applies the `.at`'s value to a key the `.at` changed, `scaffold --force` applies it to every key that differs, or edit the `.at` to match the file.
- If a CI job runs `validate --inventory`, expect exit 3 where drift exists.
- A file scaffold reports as `(user edited — kept)` is never replaced. Merge what you need from the `.at` by hand, or delete the file to have it generated again.
- An `extensions { claude-code { ... } }` key Claude Code does not have is no longer written; validate names it with the nearest known key (V130, a warning).


### Security

- Closes additional ways to reach a gated command.

### [fix] Scaffold writes the .at's structure into existing files and never their text

- An agent, skill or command marked `file:` (what `import` writes for every hand-built file) never got the `.at`'s changes: adding `skills: [lint]` to an agent, or changing its `model`, `tools` or `description`, or a skill's `allowed-tools`, left the file as it was, even with `--force`, and scaffold reported nothing. Scaffold now writes those keys into the file's frontmatter and prints one line per key, for example `~ .claude/agents/builder.md: model sonnet → haiku`.
- `scaffold --force` over a hand-written agent, skill or command at a path scaffold generates (no `file:`) replaced the whole file, prose included. It now patches only the frontmatter keys the `.at` states; the body is never written, with or without `--force`.
- A plain `scaffold` dropped text the user had added outside the prompt markers of an agent file scaffold made, while printing "(prompt preserved)". An edited agent, skill or command file now gets only its frontmatter keys; everything else in it stays.
- After any hand edit of a scaffolded agent file, the `.at`'s changes to `reads`, `writes` and `outputs` (the sections scaffold generates in the body) never reached it, and nothing was said. The manifest now records a hash of the file's frontmatter and one of its body outside the prompt markers. When only the prompt between the markers was edited, the sections around it are regenerated and the prompt kept (`~ <path>: sections outside the prompt markers regenerated, prompt kept`), as in 0.11.4. When the text outside the markers was edited too, the body stays as it is and every run names the sections the `.at` changed: `! <path>: generated sections not refreshed (the file's text outside the prompt markers was edited, so the body is kept): ## Reads, ## Writes`.
- A scaffolded agent file whose prompt markers the user removed, repeated, reordered or changed got none of the `.at`'s later changes to `reads`, `writes` or `outputs`, and nothing was said (0.11.4 regenerated those sections). Scaffold never guesses where the prompt is: the body stays as it is, the frontmatter is still patched, and when the `.at` changed a generated section every run names it: `! <path>: generated sections not refreshed (the prompt markers are missing or altered, so the body is kept): ## Reads, ## Writes`. `validate --inventory` lists the file as a `kept` drift row with the same text.
- The "generated sections not refreshed" line is printed only when it can name a section the `.at` changed. After an upgrade, a file edited outside the prompt markers printed it with no section named on every run.
- A hook command of the user's own in `.claude/settings.json` (or `.codex/hooks.json`) was deleted without a word when it sat in a hook group with one of the topology's hooks (a command added to a generated group), or when it named a topology script as an argument (`./my-lint.sh .claude/skills/<topology>/scripts/guard.sh`). The merge now decides per command, not per group: a command the `.at` generates now stays where it is, a topology command the `.at` no longer generates is replaced, and every other command stays. Each kept command that shares a group with the topology's hooks or names one of its scripts is printed on every run, dry run included: `! .claude/settings.json hooks.PreToolUse: kept a command the .at does not generate: ./my-guard.sh`. `--force` and `--prune` keep it too. Unchanged for now: a generated command the user edited by hand (an added argument, `&& ./my-check.sh` after it) is still replaced as in 0.11.x; keeping it is planned for a later release.
- An agent's `extensions { claude-code { ... } }` key that Claude Code's schema has for agents as a single value or a list (for example `memory`) now reaches a file the user edited, like a first-class key (`~ <path>: memory project → user`); it was never patched.
- The rule: the `.at` owns structure (the frontmatter keys it states for a node), the file owns content (its body and every key the `.at` does not state). Only those keys change; other keys, comments, key order, quoting, line endings and the body stay byte for byte. `name` is never patched (it is the file's identity), nor an agent's `extensions { claude-code }` key with a nested value (`hooks`, an object: import flattens those, so the `.at`'s copy is not what the file says), nor the manual-use sentence the binding appends to a generated agent's description.
- Changed behaviour: the scaffold manifest gains a `fields` map, the value each key had when scaffold last applied it. A key the file changed since is kept and reported (`! <path>: model is opus in the file, haiku in the .at`); a key both sides changed is kept and reported with both values. `--force` makes the frontmatter match the `.at`: it writes the `.at` value both for a key only the file changed and for a key both sides changed, and it still never writes the body. A key the `.at` stops stating is removed only while the file still holds the applied value. A manifest from before has no recorded values: the first run writes the `.at` value for each differing key and prints it.
- Scaffold compares a file with the `.at` the way import reads the file, so a value import brings in only in part (a block-scalar `description: |`, a flow list with quotes) counts as unchanged and is never written back over the file's text. Scaffold right after import writes no byte of an agent, skill or command file; an `.at` edit to one key writes that key only.
- Import misreads some values (a flow list written over several lines, a block list with a quoted item such as `"Bash(git log:*)"`, a list followed by a `# comment`), and adding one tool in the `.at` then wrote that misreading into the user's file (`tools: "[, Write"`). Before writing a key over a value the file holds, scaffold now reads that value itself and compares it with import's reading; when they differ (or the value is a nested block where the `.at` states one value or a list), the key is not written, with or without `--force`, unless the file still holds what scaffold last applied. The run prints `! <path>: tools not written: import reads the file's [Read, Grep] as [...], so the .at's [...] may come from a misreading (kept the file's; edit it by hand)`, and `validate --inventory` lists a `blocked` row for the key.
- A description (or any other text value) starting with `- `, `? ` or `, `, a lone `-` or `?`, or reading as a date (`2024-01-01`) was written unquoted: YAML could not read the frontmatter, or read a date, and scaffold exited 0, also when it patched the value into a hand-written file. Every text value the binding writes is now quoted when YAML would not read it back as that text: an empty or padded value, one starting with any YAML indicator, one holding `: `, ` #` or a control character, or one YAML reads as a boolean, number, null or date. A quoted value uses JSON's escapes, so a line break is written as `\n`. Values that were already valid are written as before.
- A list item YAML reads specially was written plain: `paths: ["*.ts"]` came out as `- *.ts`, which YAML reads as an alias (an error), in a fresh project too. Scaffold then could not read its own frontmatter for that file and skipped every key of an existing one, with or without `--force`, and said nothing, and `validate --inventory` showed no drift. Such an item is now quoted (`- "*.ts"`), by the same rule as other text values; items that were valid (`Bash(git log:*)`) are written as before. When the writer cannot read what the `.at` states or what the file holds, it now prints one line naming the file, the key and the reason (`⊘ <path> (user edited — kept; frontmatter not patched: "description" uses a YAML anchor or alias)`), and `validate --inventory` lists the file as a `blocked` row naming the key.
- A file whose frontmatter cannot be edited safely (text but no frontmatter, YAML anchors or aliases, a second document, a duplicate key, a value whose end cannot be found) is left as it is and the reason printed. A scaffolded file nobody edited is regenerated whole, as before.
- A file scaffold wrote that has no frontmatter for the `.at` to patch (the topology's own `.claude/skills/<topology>/SKILL.md`, a group's `SKILL.md` and `transcript.md`, the rules file `.claude/rules/<topology>.md`) was rewritten whole after a hand edit: on a plain scaffold for the skill and the group files (printed as "(prompt preserved)"), and with `--force` for any of them. A file the user edited, or one at a generated path that scaffold did not write, is now kept whole, with or without `--force`, as a user's script is, and every run prints it: `! .claude/rules/t.md (user edited — kept)`. A file still exactly as scaffold wrote it is regenerated as before; to have an edited one generated again, delete it.
- Changed behaviour: `--force` no longer replaces any file's text. It applies the `.at`'s value to frontmatter keys the file changed; every other file the user edited stays. The kept-files hint says so.

### [add] `validate --inventory` lists structure drift

- Coverage counted an agent as covered by its path alone, so an agent whose `model`, `tools` and `description` all differed from the `.at` still showed 100% and no line. With one `.at` and a project folder, `validate --inventory` now adds a "Structure drift (N of M owned keys)" section: one row per frontmatter key where the `.at` and an agent, skill or command file disagree, with the `.at` value, the file value, the value scaffold last applied, and a state (`at-ahead`, `file-ahead`, `conflict`, `at-removed`, `released`, `blocked`). Formatting alone (a comma string against a YAML list, quoting, key order) is never a row. It writes nothing; in sync, the section is absent.
- Changed behaviour: `validate --inventory` exits 3 when drift is all that is wrong (errors or missing files still exit 1). `--json` prints the report as JSON instead of text: `{ schema, file, errors, warnings, missing, ownedKeys, drift: [{ path, kind, id, key, state, at, file, base }] }`.

### [fix] A step's program counts however its name is written

- A gated step could run past its gate when its program's name was written another way than the step writes it. A program name written with a platform suffix (`.exe`, `.cmd`, `.bat`, `.com`), in other letter case, or with braces now counts as the tool it runs, with jq and without it. This covers `before-action.sh` on Claude Code and Codex, and the Codex `if:` filter.
- Programs that only share letters with the tool are not the tool: `gitk`, `git-lfs`, `legit` and `git-upload-pack` are not `git`.
- Changed behaviour: a step run under its program's other spelling (for example `tool.exe` for a `tool` step) is now that step, so its gate applies. When the step reads its unit with `unit-from` written for the plain spelling, the unit cannot be read and the call is refused, even with a passing gate record; write `unit-from` to match the spelling you run. Before, such a call skipped the gate.

### [fix] Without jq, the guard hooks read words, not letters

- With no `jq` on PATH, `before-action.sh` refused ordinary git commands that it lets run with jq: `git log @{u}..`, `git diff @{u}`, `git show HEAD^{commit}`, `git diff HEAD@{1}`, `git branch -d feat/merged`, `git log --grep=merged`, `git checkout -b emerge-fix` against a `git merge` step, and `git log --author=pushkin` against a `git push` step. It took a step as present when the step's letters appeared in order anywhere in the input (`merged` holds `merge`), and took any `{` for a shell expansion.
- Without jq, a command is now read as bash gets it: JSON's escapes decoded, quotes and backslashes dropped, a backslash at a line end joining the lines, cut into words at blanks and `;` `&` `|` `(` `)` `<` `>` `/` `=` `:` `,`. A step is present when its words appear whole and in order (`git -C d merge` is still a merge). A brace counts as an expansion only as a list (`{a,b}`) or a sequence (`{a..b}`), as with jq. `$`, a backtick and `*` `?` `[` next to a gated tool's name still refuse.
- `before-agent.sh` reads an agent's name as a word the same way, so a prompt that holds the name inside another word (`redrafter`) no longer blocks the launch; every spelling jq reads as the agent (`Drafter?`, `agents/drafter`, a zero-width space inside it) still refuses.
- Without jq, a program name written with wildcards that could match a gated tool is now refused, as it is with jq; a wildcard after a program that only reads (`ls docs/*.py`) still runs. A PowerShell command that names a gated tool is refused without jq.
- Unchanged: an empty input or a `\u` escape refuses; a gate ledger's name is still matched by its letters, as with jq. A command that holds a step's word as a word of its own (`git show v1:merge.md` against a `git merge` step) is still refused without jq; install jq to run it.

### [fix] A second block is never dropped without a message

- A topology with two top-level `hooks { }` blocks validated, and the second block's hooks never reached `settings.json`. Every `hooks { }` block is now used, in file order. A hook name used in two blocks is an error (V23) that names the hook and the lines; a hook name used twice in one block is a warning.
- A second `machines`, `extensions`, `inventory` or `needs` block was ignored with no message. It now gets the same V23 warning as a second copy of any other section: only the first is used.
- A section written as an example inside an agent's `prompt { }` was read as the topology's own and replaced the real one after the agents: a `settings { allow: ["Bash"] }` example in a prompt became `settings.json`, the real `settings { deny: [...] }` rules were dropped, and validate passed. The same held for `gates`, `mcp-servers`, `triggers`, `extensions`, `hooks`, `orchestrator`, `flow`, an `agent` and every other section. The content of a `prompt { }` block (an agent's, a variant's, a skill's), a quoted string and a `#` comment is now text: no block, field or section is ever found in it, so the real block is used. A prompt still ends at the brace that balances its content, so code and JSON samples in a prompt parse as before.
- A second `hooks { }` block inside an agent validated and its hooks reached no file. They land where 0.11.4 put them again: the agent's first `hooks { }` block goes to the agent file's frontmatter (script `<agent>-<hook>.sh`); every hook in its second and later blocks goes to `settings.json` with the project's other hooks, in file order (script `<hook>.sh`), so it runs for the whole project. A hook name used in two of one agent's blocks, or in an agent's later block and a top-level block, is an error (V23); twice in one block, a warning.

### [fix] A quoted list item may hold `]` and `,`

- A list read up to its first `]`, even one inside quotes, and split at every comma. `deny: ["Bash(rm -rf [a-z]*)", "Read(./.env)", "Bash(curl:*)"]` became the single rule `Bash(rm -rf [a-z` in `settings.json`, the other two deny rules were lost, and validate passed. The same held for an agent's `tools` and `disallowed-tools`, a skill's `allowed-tools` and `paths`, and every other list. A quoted item is now one item whatever it holds; outside quotes, brackets nest (`[Bash(rm [a-z]*), Read]` is two items). This covers every list the parser reads, `decisions`, `inventory { roots }`, `needs` lists, list values under `extensions { claude-code }` and Codex MCP `args` and `enabled-tools`.
- Changed behaviour: a list whose `]` never comes, a quoted item not closed on its line, or text after a list's `]` that is not another `key:` field (`[Bash(rm a-z]*), Write]`) is now a parse error that names the key. Before, part of the list was kept and the rest dropped without a message. A malformed list under `extensions { claude-code }` is refused with a message instead of being split.
- Text inside a `prompt { }` block or a quoted string is prose, never checked as a list: a prompt line such as `tools: [Read, Grep` still validates. When a field and prose both hold the key, the field is read, even when the prompt comes first (before, the first one in the file was read).
- Changed behaviour: a field exists only where a field is written. When an agent had no `tools`, `disallowed-tools`, `skills`, `mcp-servers`, `reads` or `writes` field, a line such as `tools: [Bash, Write]` in its prompt or its description became the field; a `hooks { }`, `extensions { claude-code { permissionMode: ... } }`, `retry` or `scale` example in a prompt reached the agent's file the same way. Prose is now never read as a field.
- A top-level hook that shares its name with an agent's own hook is no longer dropped.

### [fix] A hook or gate script you wrote is never put back to the stub

- `scaffold --force` replaced a hook's or gate's script that the user had written with the stub again, when the script lived where scaffold puts it (`run: "scripts/x.sh"` → `.claude/skills/<topology>/scripts/x.sh`), and also when the file was there before the first scaffold. The stub exits 1, which does not block on `PreToolUse`, so a guard the user built was switched off with no error. Such a script is now kept, with or without `--force`, wherever it lives, and scaffold says so on every run. A stub still exactly as scaffold wrote it is updated as before.

### [fix] Claude Code gets what the .at states, at the documented key

- `settings { sandbox: true }` (or `false`) now writes `sandbox.enabled` to `.claude/settings.json`; it was dropped. Another value (a Codex sandbox mode such as `docker`) is not written for Claude Code, and validate says so.
- `settings { fallback-chain }` now writes `fallbackModel` when every entry is a Claude Code model; it was dropped.
- A topology's `extensions { claude-code { ... } }` keys land at their documented settings path and type: `defaultMode` and `additionalDirectories` go under `permissions` (they were written at the top level, where Claude Code does not read them, and a list was written as a string), a dotted key such as `sandbox.autoAllowBashIfSandboxed` is nested, and a key with dots or digits is no longer dropped by the parser.
- An agent's claude-code extension writes number values (`autoCompactWindow: 200000`), which were dropped. A skill's claude-code extension now reaches `SKILL.md` (for example `background`, `compatibility`, `license`); it was dropped entirely.
- An agent's `sandbox` and `fallback-chain` are no longer written into its agent file: Claude Code has no such frontmatter keys and ignored them.
- New rule V130 (130 rules, warnings only, so a file that validated still does): a claude-code extension key Claude Code does not have is not written, and validate names the nearest one (`defaultMod` → `permissions.defaultMode`). The same for a value of the wrong type or outside the documented values, a settings key a project settings file cannot set (for example `skipAutoPermissionPrompt`), a claude-code extension on a hook or gate, an agent's `sandbox` or `fallback-chain`, and a settings value Claude Code cannot take. Before, the key was written where Claude Code ignores it.
- The keys come from one schema, `src/bindings/claude-code-schema.ts`: one row per agent, skill and command frontmatter key, settings key and `.mcp.json` server field Claude Code documents, with its type, values, doc page and what Claude Code enforces (measured on Claude Code 2.1.326 where a probe ran, with the conditions it holds under: subagent or session agent, before or after folder trust). A test fails if a scaffold writes a key with no row. `scripts/claude-code-schema-drift.mjs` diffs the rows with Claude Code's pages and regenerates the settings rows.
- A settings value the `.at` states was not applied when `.claude/settings.json` already held that key or its parent object (`sandbox` → `sandbox.enabled`, `defaultMode` → `permissions.defaultMode`, `fallback-chain` → `fallbackModel`, a `sandbox.*` extension key), and nothing was said. The settings merge still keeps the file's value (it only adds what the file lacks, as in 0.11.x), and scaffold now prints one line per such key, on `--dry-run` too: `! .claude/settings.json permissions.defaultMode: file has "bypassPermissions", the .at states "plan" — not changed`, or, for a key under an object the file holds, `! .claude/settings.json sandbox.autoAllowBashIfSandboxed: file has no value (its "sandbox" object is kept as it is), the .at states false — not changed`. `validate --inventory` lists each as a drift row of kind `settings` and state `kept` (exit 3); `--json` gives its `at` and `file` values as JSON text.
- Changed output: agent files of agents with `sandbox` or `fallback-chain` lose those two lines; `settings.json` gains `sandbox.enabled`, `fallbackModel` or moved extension keys where the .at states them. In the examples only `scheduled-monitor.at` changes (three agent files, and `fallbackModel` in settings.json).

### Held by tests

- An exit-code differential frozen from a v0.11.4 build on the same 9010 runs: with jq, every run exits as before; without jq, 85 runs go from exit 2 to exit 0, all in a list declared in advance by a rule written apart from the hooks, and none goes from 0 to 2. Without jq no hook lets through what it refuses with jq. The 0.11.2 differential holds the same 85 as declared.
- A second corpus of program names written other ways (40 commands, every topology, `before-action.sh` and the Codex `if:` filter, with jq and without), frozen from v0.11.4: 98 runs change, all declared in advance by rule; with jq, none goes from exit 2 to exit 0.
- Every generated file other than the three guard scripts' no-jq part and the step reader's program-name check is byte for byte as in 0.11.4.

## [0.11.4] - 2026-11-16

### [fix] A git step no longer blocks ordinary git commands

- With a step whose command is `git commit` or `git push` behind a gate, `before-action.sh` refused everyday git commands: `git diff HEAD~1`, `git log @{u}..HEAD`, `git show HEAD^{commit}`, `git diff HEAD@{1}`, `git rev-parse HEAD~2`, `git log "$BR"`. It read any word holding `~` or `{` as a shell expansion, and a command it could not read ran the gate. Present in 0.11.2 and 0.11.3: against such a topology, 11 of 40 everyday commands were refused.
- The hook now reads a word the way bash expands it. `$`, a backtick and a glob (`*` `?` `[`) still count as an expansion; `~` counts only at the start of a word or after `=` or `:`; `{` counts only as a brace list (`{a,b}`) or a sequence (`{a..b}`). `HEAD~1`, `@{u}`, `HEAD@{1}`, `HEAD^{commit}` and `a..b` are read as written.
- A git command whose subcommand is a literal reading one (`status`, `diff`, `log`, `show`, `add`, `blame`, `ls-files`, `restore`, `rm`, `mv`, `branch`, `tag`, or `commit` when no git step starts with it), and is not the first word of any git step of the topology, is not a step, so a variable in it (`git log "$BR"`) no longer runs the gate. `git grep`, an option before the subcommand other than `--no-pager`, `--no-optional-locks`, `--no-replace-objects` or `--literal-pathspecs`, and any flag that makes git run a command (`-c`, `--exec-path`, an alias, `-C <dir>`) keep the old reading. The step's own words, written out, still count: `git commit -m "$MSG"` is a commit.
- Still refused, as before: `git commit`, `git push origin main`, `git -C d commit`, `g=git; $g commit`, `git $(echo commit)`, `git {commit,x}`, `~/bin/git commit`, `sh -c 'git commit'`, `xargs git commit`, `git c${x}ommit`.
- An inline git alias could run a gated step; it's now refused. `git -c alias.x=commit x` and `V=commit git --config-env=alias.x=V x` made a commit under another name, and 0.11.2 and 0.11.3 let them through. A `-c` or `--config-env` that defines an alias, or names a config file to include (`include.path`, `includeIf.<condition>.path`), is now read as a possible step. A `-c` that defines no alias reads as before: `git -c user.name=x commit -m y` is a step, `git -c core.pager=cat log` runs.
- The same reader serves the Codex hooks, so the fix covers both, including the Codex `if:` filter (`.codex/scripts/at-if.sh`): a `strength: refuse` hook with `if: "Bash(git push*)"` no longer runs for `git log HEAD~1`.

### [fix] A missing jq no longer blocks every command, edit and launch

- With no `jq` on PATH, `before-action.sh`, `before-edit.sh` and `before-agent.sh` refused every call, so a machine without jq could run no command at all in a project with a gated step.
- Without jq, each now reads its input as raw text and refuses only when that text could hold what it guards: the input is empty or holds a `\u` escape, or its letters (after JSON's escapes) hold, in order, the words of a gated step, the file name of a gate ledger, or a gated agent's name; for a command, also an expansion or glob next to a gated tool's name. Otherwise the call runs, and the hook prints one line: `agentopology: jq is not installed; this command names no gated step, so it runs. Install jq to check steps.` (for an edit and a launch, the same line about a gate ledger and a gated agent).
- A refused call keeps its message. A launch refused for a missing jq now says `jq is required to check this launch` (it said the input was not valid JSON).
- A gated step's own action script still refuses to run without jq: that script is the step.

### Held by tests

- An exit-code differential frozen from a v0.11.2 build: 9010 runs (8 topologies, Claude Code and Codex, `before-action.sh`, `before-edit.sh` and `before-agent.sh`, and 3 Codex `if:` hooks through `at-if.sh`; every command of the existing guard tests plus the new corpora, with jq and without). 0.11.3 equals 0.11.2 on all of them. 0.11.4 equals 0.11.2 on every run except two lists declared in advance: 2606 from exit 2 to exit 0 (74 everyday git commands with jq, 38 everyday git commands behind a `strength: refuse` hook with `if: "Bash(git push*)"`, 2494 inputs without jq that name nothing gated), and 84 from exit 0 to exit 2 (28 inline git alias forms, on Claude Code and Codex, and behind that `if:` hook). Without jq no hook lets through what it refuses with jq.
- The run resolution and the settings.json merge are untouched: both 0.11.2 differentials pass, and every generated file other than the three guard scripts and the Codex `if:` filter script is byte for byte as before.

## [0.11.3] - 2026-11-16

### Changed behaviour

- `import` refuses, exits 1 and writes nothing when `<output>/<name>.at` exists (S-67); `--force` overwrites it. It used to overwrite silently. With `--force`, a symlink at that path is written through, to the file it points at, as 0.11.2 did.
- `import` exits 2 when the .at it wrote has validation errors (S-68). It used to exit 0. The file is written either way; a script that ran `import` and checked only for 0 now sees 2 for a .at with errors.
- `validate` can print a V102 warning for an `env` block inside `settings` (F5). Warnings do not change an exit code.
- `validate` refuses (V96) some runs that PASSED 0.11.2's `validate` and that only 0.11.2's `scaffold` refused ("not safe file names") (F7): an interpreter before a project-dir word whose quote closes before the slash (`bash "$CLAUDE_PROJECT_DIR"/x.sh`, also with `sh`, `node`, `python3`, `bun`), a script path with a space (`bash "$CLAUDE_PROJECT_DIR/.claude/hooks/my guard.sh"`), `~/bin/x.sh`, `node $CLAUDE_PROJECT_DIR/tools/a.mjs`, and a redirect right after a bare command (`lintme 2>/dev/null`). So `import` of a harness with such a hook now exits 2 (0.11.2's `import` exited 0), and `scaffold` still refuses it, now with the V96 error instead of "not safe file names". Nothing that 0.11.2 scaffolded is refused: 0.11.2's `scaffold` refused each of these too.
- `import` of a harness whose hook commands use these forms writes them as 0.11.2 did (a `"` inside comes back as `\"`), and `validate` refuses them with V96 as 0.11.2 did, so `import` exits 2 for them (S-68): a quoted `$CLAUDE_PROJECT_DIR` path (`"$CLAUDE_PROJECT_DIR"/.claude/hooks/x.sh`, `"${CLAUDE_PROJECT_DIR}/x.sh"`, `node "$CLAUDE_PROJECT_DIR/x.mjs"`, `bash "$CLAUDE_PROJECT_DIR/x.sh" --flag`), and a line that opens with a variable assignment (`branch=$(git ...); ...`). Compiling them is 0.12's, with S-11.
- `import` reports an error, and exits 2, for a hook that scaffold would compile to a stub: a command whose script word is a program, not the user's file or a builtin (`python3 -u x.py`, `bash -c ...`, `node -e ...`, `bun run x.ts`, `deno run x.ts`, `powershell -File x.ps1`, a tool on PATH such as `prettier --write .`, a bare or `scripts/` path the harness ran). The .at is written; import prints `Hook "<id>": this hook can't be compiled faithfully; keep it as a hand-written hook or rewrite it as a topology script` with the command as the harness wrote it, and the .at carries the comment `# ⚠ this hook can't be compiled faithfully; …` directly above that hook. 0.11.2's import exited 0 and 0.11.2's scaffold replaced each of these with a stub that exits 1, so a guard stopped refusing. The same error, and exit 2, is reported for two shapes 0.11.2's scaffold rewrote into a command that does not run as the original did: a project-path executable that is not a shell script (a `node`/`python` shebang, or a binary, e.g. `./node_modules/.bin/tool`, `.venv/bin/ruff`), which scaffold would run as `bash "<path>"`; and an absolute first word that is not an interpreter (`/usr/bin/env python3 …`, `/bin/false`), which scaffold would add as a second, broken hook. The rule (tested over 939 commands): import → scaffold never replaces a command that ran with a stub unless import reported an error for that hook.
- Which `bash <script>` / `sh <script>` hooks this flags: only those whose script is outside `.claude/hooks` (`bash scripts/x.sh`, `sh scripts/x.sh`, `bash -e scripts/x.sh`, or a script that does not exist). 0.11.2 scaffolded each of them to a stub at `.claude/skills/<name>/scripts/…` that exits 1, and the user's script was no longer run. A script under `.claude/hooks` (`bash .claude/hooks/x.sh`, `sh .claude/hooks/x.sh`) imports with exit 0 and scaffolds to the same command as 0.11.2, which runs the user's script (`bash-hook-pin-0112.test.ts`). The quoted form `bash "$CLAUDE_PROJECT_DIR/.claude/hooks/x.sh"` is refused by V96 in 0.11.2 and 0.11.3 alike (above); compiling it moves to 0.12.
- Every hook, gate and settings.json path behaves byte for byte as 0.11.2, with exactly two scaffold exceptions (below): the run resolution and the settings.json merge are 0.11.2's, held by differential tests frozen from a v0.11.2 build (2745 runs as a topology hook, a gate and an agent hook, across Claude Code, Codex, Cursor and claude-workflow; 163 scaffold, edit and re-scaffold sequences). 0.11.3 otherwise adds only import fixes and import safety.
- Scaffold exception 1 (S-12): a hook that runs the user's own script inside a `file:` authored skill folder is now installed in `.claude/settings.json`. 0.11.2 dropped it silently, so a guard the user wrote was not installed.
- Scaffold exception 2 (S-13): values in an `environments { }` block (for example production bucket names) no longer leak into `.claude/settings.json`'s `env`; only a top-level `env { }` is written there. An in-place upgrade keeps the keys 0.11.2 already leaked into an existing settings.json (the merge never removes an env key): remove them by hand.
- Both are pinned to their exact difference from 0.11.2 (`exceptions-0112.test.ts`); nothing else in those scaffolds differs.

### [fix] 0.11.3 resolves every hook and gate run exactly as 0.11.2 did; S-11 moves to 0.12

- S-11 emitted a `run:` as written when it held a shell operator, opened with a keyword or a package runner, or named a tool on PATH. On main that broke working guards: `run: "scripts/guard.sh 2>/dev/null"` became the command `scripts/guard.sh 2>/dev/null`, a path relative to the session's directory that names no file there, so the shell exits 127, 127 does not block, and a guard that refused under 0.11.2 let every call through after a re-scaffold, with no message. Two rounds of narrower fixes left the same failure for a bare script name, an interpreter with a script, and a project path, each followed by an operator. 0.11.3 drops S-11 and every hook and gate `run:` resolves exactly as in 0.11.2, on Claude Code and Codex; a run 0.11.2 refused (V96) is refused the same way. S-11's emit-as-written, import's `command <tool>` for a PATH tool, and the `CC-exit127` warning that only makes sense with it, move to 0.12.
- On main, from #50 (3390b39) until this release, scaffold carried that behaviour (F1). It was never released: 0.11.2 and earlier, and 0.11.3, resolve the script.
- Held by a differential test: 1779 runs (every run in `examples/*.at`, the shapes found while testing 0.11.3, and a cross product of first word, operator and interpreter), each as a hook and as a gate, compiled by a v0.11.2 build and frozen (`src/__tests__/e2e/differential/runs-0112.json`): 1503 resolved, 276 refused. This release gives byte-identical commands and the same stubs for every one 0.11.2 resolved, and refuses every one it refused, with no exception.
- Measured: a project scaffolded by 0.11.2, its `guard.sh` implemented as `exit 2`, re-scaffolded by this build: the hook command run by bash with a PreToolUse payload exits 2, and the gate wrapper exits 2 with the script's message (`f1-topology-script-run.test.ts`).

### Known, not fixed in 0.11.3: a hook's settings.json identity (P-1, moves to 0.12)

- Present in 0.11.2 and unchanged in 0.11.3: the settings.json merge keys a hook by its matcher and command only. Two `.at` hooks running one script with different `if:` are written as two by the first scaffold; after any edit to settings.json, the next scaffold keeps one and deletes the other. A timeout, `strength: refuse` (`onFailure: block`) or `if:` changed in the .at does not reach settings.json once the file was edited: the old entry is kept as "the same hook". A release candidate changed the identity, and a project-path hook whose timeout or `if:` changed then ran twice; 0.11.3 keeps 0.11.2's merge exactly, held by a differential test (53 scaffold, edit, re-scaffold sequences, 112 steps, frozen with a v0.11.2 build: `src/__tests__/e2e/differential/merge-0112.json`; exit code, output and settings.json byte-identical after every step). The fix moves to 0.12, with a design that knows which entries scaffold wrote.

### [fix] Fixed: an --output that cannot be read or written is a one-line error (J(3))

- A folder on the way to `--output` that cannot be read, or the folder import writes in that cannot be written (EACCES, EPERM), printed a stack or a raw `EACCES` line. It now prints `Error: cannot write to --output <path>: permission denied. Nothing was written.` before the `Importing from` line, and exits 1. A read-only `.at` with `--force` prints `Error: cannot write <file>: permission denied. Nothing was written.`

### [fix] Fixed: the package holds only what the current source compiles to

- The build never cleared `dist/`, so a published tarball could hold a compiled file whose source was removed (a release candidate held `dist/guard/exit127.js`). `npm run build` now clears `dist/` before it compiles; `prepublishOnly` runs it, and a test packs the tarball and fails on any `dist/` file the current `src/` does not produce.

### [fix] Fixed: import's write is exclusive, and a bad output path is a one-line error (F3, F4)

- Without `--force`, import creates the .at exclusively, so of several imports racing for one path one writes and the others refuse with the S-67 line. A directory at `<name>.at` prints `Error: <path> is a directory, not a .at file. Nothing was written.` with or without `--force` (it was an EISDIR stack with `--force`, and a `--force` hint without). An `--output` that is a file prints `Error: --output <dir> is not a directory. Nothing was written.` (it was an ENOTDIR stack). Each exits 1 and writes nothing, and every refusal prints before the `Importing from` line.

### [fix] Fixed: validate warns about an `env` block inside `settings` (F5)

- Since S-13 only a top-level `env { }` is the topology env, so the keys of `settings { env { ... } }` are no longer written to settings.json. `validate` now warns (V102): `` `env` is not a settings field, so its keys (FOO, ...) are not written to settings.json. Move them to a top-level env { } block. `` A project re-scaffolded in place keeps the keys that leaked into its `.claude/settings.json` before (the merge never removes an env key); remove them by hand.

### [fix] Fixed: a hook script path with a space is named by validate, not refused later by scaffold (F7)

- `bash "$CLAUDE_PROJECT_DIR/.claude/hooks/my guard.sh"` passed `validate` and `import`, then `scaffold` refused it ("not safe file names"). V96 now reports a run whose script is a project path scaffold cannot write, with the same rule scaffold uses, so `import` exits 2 and names it.

### [fix] Fixed: import exits 2 when the .at it wrote has validation errors (S-68)

- `import` printed `N error(s), M warning(s) in generated file.` and still exited 0, so a script could not tell a broken .at from a good one. Now, after writing, it validates the file as `validate <path>` does (the same rules, imports resolved from the file, so the counts match) and, when there are errors, prints `import: the .at it wrote has N validation error(s); fix them, or run validate <path> for details` and exits 2. The file is still written. A generated file that does not parse counts as one error, as in `validate`; it used to print a note and exit 0.
- Exit codes of `import`: 0, the .at is written and has no errors (warnings allowed); 2, the .at is written and has errors; 1, nothing was written (the .at exists without `--force`, the output path is a directory or under a file, or the files could not be read).

### [fix] Fixed: import no longer overwrites an existing .at; `--force` does (S-67)

- `import --output <dir>` replaced `<dir>/<name>.at` when it already existed, so a second run lost every edit made to it. Now, when that file exists (a symlink counts, even a broken one), import prints `Error: <path> exists; pass --force to overwrite. Nothing was written.`, writes nothing and exits 1. With `--force` it overwrites the file as before. The .at is the only file import writes, so the rule covers everything it writes. `--force` already meant "overwrite" for `scaffold`; for `import` it means only this file.

### [fix] Fixed: an MCP server's `env` or an `environments {}` block no longer leaks into the scaffolded settings.json; only a top-level `env` block is the topology env (S-13)

- The parser took the topology `env` from the first `env`-named block at any depth, or any word that starts with `env`, so an MCP server's `env` or an `environments { }` block leaked into the scaffolded `settings.json` `env`. Now only a top-level `env` block counts. `examples/data-processing.at` has no `env` block: its scaffolded `settings.json` no longer carries `bucket` and `output-bucket` from `environments.production`.

### [fix] Fixed: V23 counts only top-level blocks of the whole keyword (S-13)

- V23 ("Duplicate `env` block") counted a block of the same name at any depth, and any word that starts with the keyword. An imported `.mcp.json` server with `env: {}` made every such import warn, and `kitchen-sink.at` warned three times for nothing (`environments {` counted as `env`, `observability-platform {` inside `mcp-servers` as `observability`, `interfaces {` as `interface`). V23 now counts only blocks at the topology's top level whose keyword is the whole word. Two real top-level `env` blocks still warn.

### [fix] Fixed: an action a topology .at with no orchestrator puts in the flow is handled (S-13)

- When `import` takes flow from a project's `.at` that states no orchestrator (a plain pipeline ending in a `report` action) and the project also has a topology skill with one, the action came in through the flow but not into `handles`, and failed V9. Every action in the imported flow is now in the orchestrator's `handles`, after the ones the author listed.

### [fix] Fixed: a project with several topology skills imports one orchestrator that handles all their actions (S-13)

- `import` kept the flow of every topology skill in `.claude/skills/*/SKILL.md` but only the first skill's `Handles:` line, so each action another skill's flow uses failed V9 ("used in flow but not in orchestrator.handles"). The one orchestrator now handles the union of every topology skill's `Handles:`, first skill first.

### [fix] Fixed: a hook that runs the user's script inside an authored skill folder stays in settings.json (S-12)

- A hook such as `python3 .claude/skills/<skill>/references/guard.py` (scaffolded as `python3 "$CLAUDE_PROJECT_DIR/.claude/skills/<skill>/references/guard.py"`) was removed from the scaffolded `settings.json` when that skill was imported with `file:`. The stub for the user's script (written only if missing) sat in the authored folder, so it was dropped, and the hook naming it was dropped with it. Now only a generated file the hook needs (a gate wrapper) takes its hook with it. A stub the user owns does not, and nothing is written inside their folder.

### [fix] Fixed: an imported agent's output-format is never a markdown fence (S-09)

- The importer read `Output format:` from an agent file's body with a pattern that crossed the newline, so a brief that says "Output format:" above a fenced example imported as `output-format: ```` and failed V36. The value must now be on the same line and be one of `text`, `json`, `json-schema`; any other value is dropped, and the import says so in its header (`# Import warning: agent x: "Output format: markdown" is not text, json or json-schema; dropped`). The body is still read, because scaffold writes `Output format: json` there.

### [fix] Fixed: import names a hook from a project-dir command (S-01)

- Import reads a word that starts with the project-dir variable (quoted or not, `$CLAUDE_PROJECT_DIR`, `${CLAUDE_PROJECT_DIR}`, `${CLAUDE_PROJECT_DIR:-.}`) as the project path it names, to give the hook its id (S-02). `validate` and the bindings read such a `run:` as 0.11.2 did, and V96 refuses the quoted forms; compiling them is 0.12's, with S-11.
- Not in 0.11.3, moved to 0.12 with S-11: decoding `\"` and `\\` in a quoted .at value. A quoted value reads as in 0.11.2, so an imported command `node "$X/a.mjs"` parses back as `node \"$X/a.mjs\"`, and a hand-written `run: "echo \"x\""` runs `echo \"x\"`.

### [fix] Fixed: an imported hook's id is a valid identifier, from its event and matcher (S-02)

- `import --target claude-code` named a settings.json hook after the last path segment of its command, raw: `hook guard.py" --flag {`, `hook uv run --project "$CLAUDE_PROJECT_DIR" tool {`, and `hook null 2>&1 || true {` when the command named no script. The parser then lost the hooks block (V102, V98, V95, V100). The id is now the script's name when the command runs a script file with a clean name, else the event and matcher (`pre-tool-use-edit-write`, `session-start-startup`), lower case, de-duplicated with `-2`, `-3`. This makes the imported hooks block parse; it does not make every imported .at valid. Measured on 0.11.3: of 12 scaffolded examples, 6 import with V96 errors, and of 57 hand-built hook commands, 22 do, because V96 refuses the quoted `$CLAUDE_PROJECT_DIR` form as 0.11.2 did (compiling it is 0.12's, with S-11); `import` exits 2 for those (S-68).

## [0.11.2] - 2026-11-16

Scope: 0.11.2 only warns, except that a `.claude/settings.json` that is not valid JSON or whose root is not an object now stops the run instead of being overwritten. It names the rules in `.claude/settings.json` that the .at does not declare, and `scaffold --prune` keeps settings.json instead of deleting it. The rules are written exactly as 0.11.1, and prune never deletes settings.json; removing a rule the .at no longer declares is not in 0.11.2.

### [fix] Fixed: a rule removed from the .at stays in settings.json, and now scaffold says so

- 0.11.x merges permission rules into `.claude/settings.json` and removes none automatically, so a rule removed from the .at stays in effect. `scaffold` and `guard --target claude-code` now name each allow, ask and deny rule in `.claude/settings.json` that the .at does not declare in that list: `.claude/settings.json allow "<rule>": still in effect; the .at does not declare it — remove it if you didn't add it by hand`. Each rule prints as a JSON string, so a newline or an escape sequence in a rule cannot forge or erase a line of output. The file is written exactly as 0.11.1, and prune never deletes settings.json.
- The manifest entry of `.claude/settings.json` keeps the set last named (`undeclaredRulesNamed`, optional). The full list prints when a rule joins the set; every other run while any rule is undeclared prints one line, `N rules in .claude/settings.json aren't declared in the .at: <the first 5> and K more; declare them in the .at to keep them, or remove them` (for one rule: `1 rule in .claude/settings.json isn't declared in the .at: <rule>; declare it in the .at to keep it, or remove it`). It stops only when each rule is declared in the .at or removed from settings.json. `--dry-run` prints the same lines and writes nothing. Removing the rules the .at wrote is planned for 0.12.

### [fix] Fixed: scaffold --prune never deletes settings.json

- A `scaffold --prune` after the .at stopped generating `.claude/settings.json` deleted the file, with every rule, hook and key written into it by hand, and also when the file existed before the first scaffold. Prune now keeps it and prints `= .claude/settings.json (kept: holds settings; delete it by hand if you want)`; `--dry-run` prints the same line. A settings.json changed since this topology wrote it (by hand, or by another topology in the same directory) is kept with the 0.11.1 line `⊘ .claude/settings.json (no longer generated, but edited — kept)`, as before. Every other file prune deletes is deleted as before. A kept settings.json counts as unchanged in the summary line, so a run after the .at stopped generating it shows one more `unchanged` than 0.11.1, and a prune one fewer `deleted`.

### [fix] Fixed: an invalid settings.json gives a clear error

- `scaffold` and `guard --target claude-code` stopped with a stack trace when the .at writes `.claude/settings.json` and the file on disk was not valid JSON, or was valid JSON whose root is `null`; a root of `[]`, a string, a number or a boolean did not stop the run, and the file was rewritten without its content. They now print one line, `Error: .claude/settings.json is not valid JSON (<parse message>). Nothing was written.` or `Error: .claude/settings.json is not a JSON object (its root is an array). Nothing was written.`, exit 1, and write nothing.

### [fix] Security: validate warns that a compiled Codex allow rule runs outside the sandbox (CX13-allow)

- Each settings allow entry that compiles to a Codex rule with `decision = "allow"` now gives a `CX13-allow` warning at `validate --target codex`, quoting the Codex docs at https://learn.chatgpt.com/docs/agent-configuration/rules.md: "`allow`: Run the command outside the sandbox without prompting." The rules written do not change.

## [0.11.1] - 2026-11-13


### [fix] Fixed: the workflow binding's README, seam and lossy report describe only the topology (O-006)

- The `claude-workflow` binding printed one pipeline's wording into every generated `-README.md`, `-SEAM.md` and `-LOSSY-REPORT.md` (named phases and report files that belong to no other topology). They now say only what the topology itself declares. The example hybrid harness is replaced by a new neutral one, `examples/hybrid-release.at`.

### [fix] Fixed: the step and ledger guards fire for PowerShell and Monitor

- Fixed: the step and ledger guards fire for PowerShell and Monitor. On PowerShell setups (Windows without Git Bash, or pwsh enabled), 0.11.0's step and ledger guards did not fire; on Claude Code before 2.1.314 a Bash hook does not fire for Monitor, and guard --check now says so.
- `before-action.sh` is registered on `Bash|Monitor|PowerShell` (was `Bash`), still with `"onFailure": "block"`. A Monitor call with no command (a `ws` input) passes. A PowerShell command is read the same way as a Bash one, with a backslash read as a path separator (`.\tool publish ep1`), and any mention of the tool not read as a declared step (`& ./tool @(...)`, `Start-Process ./tool -ArgumentList "publish","ep1"`, `.\tool.exe`) is refused as doubt. `Get-Content`, `gc`, `Select-String` and `sls` count as reading only, so `Get-Content` of a ledger passes the ledger guard.
- `guard --check` grades a before-action gate `refuse (Bash), unverified (PowerShell: not measured)`: the PowerShell payload is from the Claude Code docs, not measured. Below Claude Code 2.1.314, or with the version unknown, the line adds `Monitor commands not checked on …`. A project scaffolded by 0.11.0 reads `none (PowerShell: not in the matcher; rerun guard --target claude-code)`. The generated SKILL.md Enforcement line of a ledger gate says the same.
- Scaffold output changes for every topology with a before-action guard: `.claude/settings.json` (the matcher), `before-action.sh` (the header and the PowerShell reading) and the skill's `SKILL.md` (the Enforcement line). Rerun `scaffold` or `guard --target claude-code`.

## [0.11.0] - 2026-11-13

### [fix] Fixed: a generated action script finds its gate check from where it sits, not from CLAUDE_PROJECT_DIR (D-10)

- `action-<step>.sh` located the project, and with it the `before-action.sh` it asks, through `CLAUDE_PROJECT_DIR` when set. A caller could point that at another folder. The script now uses only its own location (`.claude/skills/<topology>/scripts/`, four folders below the project). Found in the second design review (rated plausible, read only); a reproduction was not run, so this is hardening, pinned by a test of the property.

### [fix] Fixed: a Codex gate held by cited code grades unverified, not refuse (D-9)

- `guard --check --target codex` gave a gate with an `at:` citation its declared strength, so a cited refusal read `refuse` on Codex, where release 1 grades every guard `unverified` or `none`. It now reads `unverified`, with the citation ("cited, not proven") and the bypass kept in the notes; a broken citation still reads `none`.

### [fix] Fixed: guard --check says on the grade line when a refuse fails open or sits on a stop event (D-8)

- A `PreToolUse` guard entry without `"onFailure": "block"` kept the grade `refuse`, with only a ⚠ note below it, though Claude Code lets the call run when such a hook crashes. Its grade now reads `refuse, fails open on a crash (no onFailure: block)` (the before-action, before-agent, approval and session guards, and a cited hook). A gate held at `SubagentStop` reads `refuse, a stop event: it cannot block a call`, with a note that exit 2 keeps the agent working. The `guard --check` text pins for every example with a SubagentStop gate change.

### [fix] Fixed: before-edit.sh refuses a ledger edit in any letter case (D-7)

- `before-edit.sh` compared an edit's path with the ledger's pattern case-sensitively, so on a case-insensitive disk (macOS) a `Write` to `logs/ep1/TRACE.JSONL` reached the ledger. Path and pattern are now compared lower-cased, on both targets. Every `before-edit.sh` changes.

### [fix] Fixed: the ledger note appears wherever a grade is shown (D-6)

- The F-4 note (`ledger agent-writable until the signed gate`) was on the `guard --check` grade line and in the visualizer's node panel, but the Guards lens table showed a bare `refuse` chip, and the counts (`enforcement: N of M steps refuse`, the visualizer headline, `visualize --print-summary`) counted ledger gates unqualified. The Guards lens row now carries the note under the chip, and each refuse count adds `(K with an agent-writable ledger)` when K > 0.

### [fix] Fixed: a Codex refuse hook that can never fire, or never block, is a validate error (D-5)

- Five hook shapes compiled for Codex with no error and then never refused: a regex over tools Codex lacks (`Web.*`), a list with spaces (`Edit , Write`, kept as written), `if: "Read(secrets/**)"` with no matcher (the filter passes every call), `on: PostToolUse` with `strength: refuse`, and a regex with lookaround. Now a list with spaces is trimmed and rewritten (`apply_patch`); for `strength: refuse`, a regex matching no Codex tool (`CX8-regex`), a plain list or an `if:` naming a tool Codex lacks (`CX8-tool`; the `if:` hook gets no entry) and an event that cannot block (`CX8-event`) are `validate --target codex` ERRORs, warnings on other hooks; lookaround is a `CX8-regex` warning.

### [fix] Fixed: two approval steps before one agent make one ask decision (D-4)

- With two `human` steps before one agent, `before-agent.sh` printed two `ask` JSON objects, which is not one JSON document, so Claude Code could ignore the decision and launch the agent. The script now collects each step's reason and prints a single decision whose reason joins them. Every Claude Code `before-agent.sh` with an approval step changes.

### [fix] Fixed: guard --check credits a cited hook's refuse only when it can block (D-3)

- A gate credited by a hook its edge cites read `refuse` whenever that hook declared `strength: refuse` and sat in `.claude/settings.json`, whatever its event: a `PostToolUse`, `async: true` hook printed `refuse`. Now a cited hook gives `refuse` only as a non-async `command` hook on `PreToolUse`, `UserPromptSubmit` or `PermissionRequest`; on an event that cannot block a call, or async, the gate grades `none` with a note naming why; a `prompt`/`agent`/`http` hook grades `unverified`. `validate` warns (V104) for `strength: refuse` on an event that cannot block, or with `async: true`.

### [fix] Fixed: a unit-from step on a flat ledger needs its own unit (D-2)

- With `record trace { path: "logs/trace.jsonl" }` (no `{unit}`) and a step with `unit-from`, a command the guard saw as the step but read no unit from (`./tool -v publish ep1`) was checked with an empty unit, and the ledger filter then took the last record of any unit. An empty capture was dropped rather than denied. Now, on both targets, a `unit-from` step with no unit read, or an empty one, is refused whatever the ledger path; `agentopology step check` asks for `--unit` for such a step; and `validate` warns (V111) when a `unit-from` step's gate ledger path has no `{unit}`, naming the step, the gate and the path. Every `before-action.sh` with a `unit-from` step changes.

### [fix] Fixed: a gated step's action script checks what it runs, with no usage exemption (D-1)

- The F-6 gate check in `.claude/skills/<t>/scripts/action-<step>.sh` handed `before-action.sh` the step's words plus the script's arguments, then ran the declared commands without them. So `bash action-publish.sh --help` was checked as `./tool publish --help`, the usage exemption passed it, and the script ran `./tool publish` with no ledger. The check now runs with `AT_NO_USAGE=1` (honored by `before-action.sh`: no usage exemption), and the arguments count only as the unit: a step with `unit-from` takes exactly one plain unit name and refuses `--help`, `-h`, `--version`, no argument or two; a step without one leaves its arguments out of the check. The `action-<step>.sh` of every gated step changes.

### [fix] Fixed: at a guard's deadline nothing the check started is left running (F-17)

- A mutation pass on the release candidate found that no test checked the deadline's kill stage, and a new test showed why it mattered: a gate check that ignored TERM was still running after the hook returned, on both paths. GNU `timeout -k` sends its KILL only when its direct child survives, and the watchdog walked the process tree from a launcher that had already exited. The deadline now sends KILL at once (`timeout -s KILL`, which signals the whole process group; the watchdog kills the tree while the run is alive), so the hook returns only when every process the check started is gone. The call was refused in both cases; what changes is the leftover process.
- New behaviour tests also kill three mutants that only the golden hash caught: `--help` inside a step's words (still a step), a second mention of the tool hidden in a command substitution, and a unit of `..`.

### [fix] Known gap, narrowed: the agent can write a gate's ledger (F-4)

- In 0.11.0 a gate's ledger (`records { record trace { path: "logs/{unit}/trace.jsonl" } }`) and the Codex approvals file (`.codex/state/approvals.jsonl`) are files in the workspace, and the agent could write an ok line into them. The guards now refuse commands and edits that name them: `before-action.sh` refuses a `Bash` command that names a ledger unless it only reads it (`cat` and `jq .` still run; `>`, `tee`, `cp`, `sed -i`, `python3 -c` and the like are refused), and a new `before-edit.sh` refuses a `Write`/`Edit`/`MultiEdit`/`NotebookEdit` (Claude Code) or an `apply_patch` (Codex) that touches one. `guard --check` says so on the grade itself: `refuse, ledger agent-writable until the signed gate` on Claude Code, `unverified, ledger agent-writable until the signed gate` on Codex.
- A determined agent can still write them through a path the guard can't see (a variable set elsewhere, another script). The signed gate in the next release closes this.

- The visualizer's Guards lens and node panel show the same note on the grade (`refuse, ledger agent-writable until the signed gate`), as `guard --check` prints it.

### [fix] Fixed: the step guard looks for the tool where bash runs it, so reading a script is no step (P1-d)

- The deny-on-doubt matcher refused 18 of 42 ordinary commands on a real topology while a gate was unmet: `cat`, `ls`, `grep`, `git diff`/`log`/`add`/`commit` on the step's script, and commands whose letters merely held the tool's name (`docs/media-engine/*.py`, `echo $HOME immediately`). The guard now looks for the tool where bash runs a program, or as an interpreter's script; a program that only reads or prints its arguments runs no step unless a flag can make it run one; a program that can run its arguments, or one it does not know, is still scanned; doubt comes from an expansion or glob among the tool's own words, not from letters anywhere in the command. `echo ./tool publish ep1` is no step again ([N42] AG23).
- Measured before release by a differential fuzzer (not shipped in the package): 0 bypasses in 20,000 commands on each target, each allowed command run with real bash against a logging stand-in tool. The fuzzer found the one gap of this change before release (a wrapper between `find -exec` and the tool) and a test pins it.

### [fix] Fixed: a gate's code citation (`at`, `match`, `bypass`) reaches the Codex output and `guard --check` (F-23)

- On Codex, `gate.at`, `gate.match` and `gate.bypass` were dropped with no warning, and `guard --check --target codex` ignored them while the Claude Code check reported them. `AGENTS.md` now names the cited code, the text expected there and the bypass, and the Codex check reads the citation on disk the way the Claude Code one does. The Codex zero-drop test has a gate that sets all three.

### [fix] Fixed: a gated step's generated action script checks the gate itself (F-6)

- Claude Code scaffold writes `.claude/skills/<t>/scripts/action-<step>.sh`, whose body runs the step's commands. Only the `PreToolUse` hook on Bash checked the gate, so `bash .claude/skills/ship/scripts/action-publish.sh ep1` reached `./tool publish` with no ledger at all. The script of a gated step now hands each command, with its arguments, to `before-action.sh` (the same check, reused, not copied) and exits 2 before running anything when a gate is not met. The `action-<step>.sh` of every gated step in the examples and fixtures changes.

### [fix] Fixed: a Claude Code rescaffold replaces a gate's old SubagentStop group (F-13)

- R-8 ownership read a Claude Code command as whitespace tokens equal to a script path, but scaffold writes `bash "$CLAUDE_PROJECT_DIR/.claude/skills/<t>/scripts/x.sh"`, which has no such token. After a gate's `after:` moved, the rescaffold kept the stale group next to the new one, and the gate ran on both agents. A path right after `$CLAUDE_PROJECT_DIR/` is now read too. The new test scaffolds with the CLI, moves `after: writer` to `after: editor`, rescaffolds, and finds exactly one group for the gate, with the user's own group untouched; the old test fed a form the generator never writes.

### [fix] Fixed: three mutants of the Codex guards no longer survive the suite (F-17)

- Deleting the watchdog's KILL stage, the `if:` filter no longer reading `*** Delete File:`, and the GNU `timeout` path returning a check's raw exit code instead of 2 each left every test green. New tests fail under each: a TERM-ignoring check must free the hook's pipe within deadline + 3 s on the POSIX path; a patch that updates one file and deletes `.env` must be refused; a check that exits 3 must come out as exit 2. Each was proven by applying the mutation in a copy of the tree and seeing that test fail.

### [fix] Fixed: a Codex refuse hook blocks when its script is missing, the cwd is a nested repo, or it runs too long (F-8, F-16, F-26)

- A `strength: refuse` hook that was not one of the built-in guards, with or without `if:`, ran its script by `$(git rev-parse --show-toplevel)/…`: from a nested repository, or with the script deleted, it exited 127 and Codex let the call run. It also had no hook timeout and no deadline, and a timed-out hook lets the call run too. Every refuse `PreToolUse` hook now goes through the guard launcher: it climbs to its script, a missing script or any launcher failure is exit 2, and it carries a hook timeout (its own, else 120 s) with the R-3 deadline under it. The `if:` filter is launched the same way and runs the hook's script from the root it found.
- Hooks that are not refuse had the same 127 from a nested repository. They now climb to their script the same way, and a missing script exits 1, which does not block.

### [fix] Fixed: the Codex guard deadline frees the hook's output pipe on time (F-9, F-20b)

- The deadline returned exit 2 on time, but a check that ignored SIGTERM, or left a background process, kept the hook's stdout and stderr open 9 to 15 s past it; Codex reads to EOF and could reach its own hook timeout, which lets the call run. Both the GNU `timeout` path and the POSIX watchdog now send the run's output to temp files and copy them out after the run ends or is cut. When the deadline fires, the watchdog's KILL stage runs to its end, and the watchdog's own `sleep` is killed with it, so it never outlives the hook. In the GNU path a KILL after `-k` (137) also reports the deadline, and any non-zero exit is exit 2. An absolute script path is run where it is, with no climb.

### [fix] Fixed: a Codex refuse hook whose matcher is a regex of Claude tool names no longer goes silent (F-7)

- A matcher such as `(Write|Edit)`, `^Write$`, `Ed.*` or `Task.*` was written to `.codex/hooks.json` unchanged with no warning, so it never fired on Codex, which calls those tools `apply_patch` and `collaborationspawn_agent`. Names inside one group or between `^` and `$` are now rewritten (`(apply_patch)`, `^apply_patch$`). A real regex that matches a Claude tool but not its Codex name gets `CX8-regex` from `validate --target codex`: an ERROR for `strength: refuse`, a warning for any other strength.

### [fix] Fixed: a Claude Code `strength: refuse` hook blocks when it cannot run (F-14)

- Only the generated guards carried `"onFailure": "block"`. A user's `PreToolUse` hook with `strength: refuse`, in `hooks {}` or on an agent, had none, so a script that could not start or timed out let the call run. Every such hook now gets it; no existing `onFailure` is removed. `validate` warns with `CC-onfailure` when the installed Claude Code is older than 2.1.295, which ignores the field.
- Claude Code `before-agent.sh` compared `subagent_type` as sent, so ` Reviewer `, `REVIEWER` or `agents/reviewer:` launched a gated agent. It now normalizes the name as Codex does (F-15). The Claude Code `before-agent.sh` of `codex-gates.at` and `compile.at` changes.

### [fix] Fixed: Codex `before-agent.sh` holds an agent however its name is spelled (F-15)

- The spawn guard compared `agent_type` after trimming and lowercasing only, so `re\u200bviewer`, `\ufeffreviewer`, `./reviewer`, `agents/reviewer` and `reviewer:` started a gated agent. It now drops format characters (`\p{Cf}`), a leading path, trailing punctuation and a `plugin:` prefix too. A missing or `null` `agent_type` is still let through: it is Codex's default agent, and the docs now say so.

### [fix] Fixed: the Codex `if:` filter sees `.env` however an `apply_patch` spells its path (F-12)

- `at-if.sh` compared a patch's paths as written, so `$ROOT/./.env`, `$ROOT//.env`, `sub/../.env`, `./.env` and `/proc/self/cwd/.env` passed a `strength: refuse` hook with `if: "Write(.env*)"`. Each path is now made canonical by its letters (relative paths from the current folder, `/proc/self/cwd` as the project root, `.`, `..` and `//` resolved, the root stripped; glob characters in a path are not expanded). A pattern with no slash, such as `.env*`, now also matches the file's name at any depth.

### [fix] Fixed: a stub runs under the interpreter its hook or gate command uses (F-24, F-25)

- A hook with `run: "sh scripts/x.sh"` got a bash stub (`set -euo pipefail`), and the hook command ran it with `sh`. Dash rejects `-o pipefail` and exits 2, so on both targets a fresh scaffold blocked every matching call by accident. A stub now has a POSIX sh body when `sh` runs it, and a hook stub that is not `strength: refuse` exits 1 as designed.
- A gate whose `run:` names a `.py` file got a bash stub (a Python `SyntaxError`, exit 1), and a `.js` / `.mjs` one was run with bash. Gate and hook stubs are now written in the file's language (Python for `.py`, JavaScript for `.js` / `.mjs` / `.cjs`) and run by the matching interpreter. On Claude Code a non-project `.py` script is now run by python3, not bash. The Claude Code stub for `compile.at`'s `docs/tools/check.py` changes.

### [fix] Fixed: a Codex gate's check stub is written where the gate runs it (F-22)

- A gate with `run: "checks/review.sh"` got its stub at `.codex/scripts/review.sh`, while `gate-<id>.sh` runs `checks/review.sh`. Filling in the stub never let the gate pass. The stub is now written at the declared project path (created once, never overwritten), as on Claude Code; a bare name still goes to `.codex/scripts/`, and an absolute path is never stubbed.

### [fix] Fixed: Codex `AGENTS.md` says what holds a gate in the words `guard --check` grades it (F-29)

- A gate before a script step with a `run:` script and no ledger read "refuses the step's command until the ledger shows the gate held", though it has no ledger. The line now names what `before-action.sh` checks: the ledger of the `after:` step, the gate script, or both.
- A gate no Codex event marks read "script-level" in `AGENTS.md` and `hope` in `guard --check`. It now reads `hope` in both, with the script to run by hand.

### [fix] Fixed: Codex `AGENTS.md` no longer hands the model a command that approves a human step (F-10)

- `AGENTS.md`, which Codex loads into the model's context, held a ready-to-run `printf ... >> .codex/state/approvals.jsonl` line under Human Checkpoints, so the model had its own approval one paste away. It now describes the record for the person in words (the file, the fields `step`, `ok`, `at` and what they mean) and holds no line that writes it. The R-11 test checks that neither `AGENTS.md` nor any guard's stderr has a `printf`, `echo`, `tee` or `>>` line naming `approvals.jsonl`.

### [fix] Fixed: inventory on a Codex-only scaffold counts nothing scaffold wrote as unmapped (F-28)

- `validate --inventory` on a project scaffolded only with `--target codex` listed `.codex/.scaffold-manifest.json` as unmapped and every Claude Code file as "not scaffolded". The scaffold manifest (either target, shared or per topology) is now mapped, and a project with a Codex tree and no `.claude/` is not told to scaffold the Claude Code files.

### [fix] Fixed: `validate --target codex` names the Codex version, not Claude Code's (F-20, F-27)

- `agentopology validate <file> --target codex`, with or without `--inventory`, ended with `checked against Claude Code 2.1.323`. It now prints the target's own line (`checked against Codex CLI 0.156.1 ...`); with no `--target` it still prints the Claude Code line, and a target with no conformance facts prints none.
### [fix] Fixed: a Codex `if: "Bash(...)"` filter reads the command the way the step guard does (F-11)

- `if: "Bash(git push*)"` on a refuse hook matched the whole command against the glob only, so ` git push`, `cd . && git push`, `git  push`, `git -C . push`, `command git push`, `true; git push`, `GIT_TRACE=1 git push` and `/usr/bin/git push` all ran. The filter now shares the step guard's reading: the glob's literal words (`git`, then `push`) are found in any segment, behind a prefix, at any path, in any case, with flags between them; the whole-command glob test still holds; and a refuse hook treats a mention of the tool it cannot read (an expansion or glob) as a match.

### [fix] Fixed: the step guard refuses what it cannot read, and reads interpreter steps by their script (F-1, F-2, F-3, F-5, F-19, F-21)

- An adversarial review of the 0.11.0 candidate ran guarded steps past `before-action.sh` (both targets) in ordinary shell forms: a backslash line continuation, a redirect glued to or between the words (`./tool publish>/dev/null ep1`, `./tool 2>&1 publish ep1`), an expansion or glob inside the words (`${IFS}`, `$'...'`, `{publish,}`, `pub*lish`, `./to?l`), upper case (`./TOOL`, a bypass on a case-insensitive disk), and a second step in the same command riding the first step's ok record. A step run through an interpreter (`python3 harness/bin/post.py`) passed as `python3 ./harness/bin/post.py`, by an absolute path, or as `python post.py`.
- The guard now joins line continuations, drops redirections before it cuts the command, matches the tool in any case and at any path (for an interpreter step, the script under any interpreter), and lets flags sit between the step's words. What it cannot read it refuses: a command that holds an expansion or glob and names the tool more often than the step can be read plainly, or a glob or brace word that could expand to the tool, is refused for a step with a unit. Every unit a command names needs its own ok record. `<step> --help` alone is no step.
- This over-blocks more than before while a gate is unmet: a command that mixes the tool with `$`, a glob or `~` is refused, as is a mention of the tool's name in a command with an expansion. The shipped Claude Code `before-action.sh` changes.

### [feature] `validate --target <binding>` (E-6)

- The Codex warnings (`CX5-*`, `CX8-*`, `CX9-*`, `CX11-*`, `CX13`, `CX20`, `CX23`) appeared only at scaffold, though the CX-23 entry says `validate` with a Codex target shows them. `agentopology validate <file> --target codex` now adds them; plain `validate` stays target-neutral.

### [fix] Fixed: the Codex scaffold drops no gate description, gate behavior or tool script path (E-4)

- The `AGENTS.md` gate section never printed a gate's `description` or `behavior`, and a tool's stub was written to `.codex/scripts/<id>.<ext>` instead of its declared `script:` path. Both gate fields are now printed, and the tool stub is written where `script:` says, as on Claude Code: a project path is created once and never overwritten, an absolute path is never touched. The Codex zero-drop test now also checks tool scripts, with a fixture that sets all three.

### [fix] Fixed: a guarded step's command with placeholders matches the real call (E-3)

- `before-action.sh` (both targets) compared a step's command literally, so `commands: ["./media episode render EP.json OUT.mp4"]` never matched the real call `./media episode render show/ep7/ep.json out.mp4`, and the gate never held. Now the command is matched on its words before the first placeholder: an ALL-CAPS word (`EP`, `PID`, `OUT.mp4`) or a word holding `< > { } [ ]`, and everything after it. `validate` warns with `AG-placeholder` and names the words matched. The Claude Code `before-action.sh` of such a topology changes too.

### [fix] Fixed: every generated stub fails closed; 0.10.1 and earlier (0.9.x included) graded an unwritten tool stub "refuse" while its gate passed (E-1)

- In 0.10.1 and earlier (0.9.x included: the Claude Code binding predates 0.10), a tool's script stub (and the hook, metering and workflow-seam stubs) printed a TODO line and exited 0. A gate whose check was such an unwritten stub therefore passed, and `before-action.sh` let the step run, while `guard --check` graded the gate `refuse` and said the stub "blocks every run". In 0.11.0 every generated stub, on both targets and in every language (bash, python, node), carries the `AGENTOPOLOGY_STUB` marker and fails closed: a check that must refuse exits 2, every other stub exits 1 (an error that does not block a stop event), so a gate that runs it blocks. Codex tool stubs now carry the marker too. This changes the Claude Code stub scripts; `guards-golden.json` is re-blessed in its own commit.

### [fix] Fixed: Codex guards are graded unverified, and a gate with no blocking event reads none (R-1)

- `AGENTS.md` called every Codex gate "Enforcement: hook". No live Codex run has proven a guard holds yet, and Codex skips an untrusted project's hooks silently, so every Codex guard on disk now reads `unverified` in `AGENTS.md`, in the gate wrapper's comment and in `guard --check`, never `hook` or `refuse`. A gate whose only event is `SubagentStop` (after the last agent, with nothing after it to hold) reads `none`, and `validate` / `scaffold` warn with `CX9-noblock`.

### [fix] Fixed: `guard --check --target codex` wrote files (E-2)

- With `--target`, `guard` took the write path before it looked at `--check`, so `guard <file> --check --target codex` wrote the guards into the project. `--check` now never writes, on any target.

### [feature] `guard --check` grades a Codex project (E-5)

- On a Codex scaffold `guard --check` graded `.claude/` only: it printed "0 of 4 refuse", listed missing `.claude` entries and exited 1. `guard --check --target codex`, or a project with `.codex/` and no `.claude/`, now reads `.codex/hooks.json` and `.codex/scripts/<topology>/`: a guard on disk reads `unverified`, a missing one `none` (exit 1), a gate with no blocking event `none` without failing, and the version line names Codex CLI. It exits 0 when nothing is missing.

### [fix] The Codex human gate does not hand the model its own approval (R-11)

- When an approval step blocked a spawn, `before-agent.sh` printed the exact `printf … >> .codex/state/approvals.jsonl` command to stderr, which Codex shows the model. With `permissions: unrestricted` (so `sandbox_mode = "danger-full-access"`), or no sandbox and `approval_policy = "never"`, the model could run it and approve itself. Now stderr says a person must add the record and the model must not; the record format and the command are in `AGENTS.md` under Human Checkpoints. `validate --target codex` (and scaffold) warns with `CX11-forgeable` when a human step stands before an agent and the sandbox lets the model write `.codex/`.

### [fix] Fixed: the guard matcher refuses a gated step however the command is spaced, wrapped or quoted, and the shipped Claude Code hook scripts change (R-4)

- `before-action.sh` (shared by Claude Code and Codex) let these run a gated step with exit 0 when the gate's ledger had no ok record: double spaces or a tab between words, `if …; then` / `while …; do` / `! …`, `$(…)` and backticks, a `command` / `nice -n 5` / `sudo -u x` / `env -i` / `xargs` prefix, quotes (`"./tool" publish`, `./tool 'publish'`), and the tool named by an absolute path. The matcher now refuses every one of those forms (exit 2). It also cuts the command at `(`, `)`, `$(` and backticks, drops quotes and backslashes, makes whitespace single spaces, and finds the step's words anywhere in a segment, its program also by any path ending in its name; `bash -c '…'` and `eval …` with the step written out are refused too. It over-blocks on purpose: `echo ./tool publish ep1` is now refused while the gate is unmet (it used to pass). A step named through a variable, an alias, a function or another script is still not seen.
- **The shipped Claude Code hook scripts change:** every generated `.claude/skills/<t>/scripts/before-action.sh` is different. The fix wins over byte-identical output (decision 2026-11-13), because the old matcher let a gated step run; `guards-golden.json` is re-blessed in its own commit.

### [fix] The Codex if: filter runs its command as argv (R-7)

- `at-if.sh` ran the hook's command with `sh -c "$*"`, which joins the words again: in a project whose path holds a space ("fx 3") the script path split, the run exited 127, and Codex let the call run. The filter now runs the command as given (`"$@"`); an inline shell command such as `exit 2` is passed as one `sh -c` word. On a `strength: refuse` hook, a command that cannot be found or run (126, 127) blocks with exit 2, and the filter itself is found the way the guards are (R-2).

### [fix] The Codex if: filter reads the paths of an apply_patch (R-6)

- On `apply_patch`, `.codex/scripts/at-if.sh` read `.tool_input.file_path` / `.path`. Codex sends the patch text in `.tool_input.command`, with absolute paths, so `if: "Write(.env*)"` never fired; input that was not JSON also passed (exit 0). Now every `*** Add File:`, `*** Update File:`, `*** Delete File:` and `*** Move to:` path in the patch is made relative to the project root and matched. On a `strength: refuse` hook, input that is empty, not JSON, or a patch with no readable path blocks (exit 2).

### [fix] Claude tool names in a Codex hook matcher are rewritten (R-5)

- A hook with `matcher: "Edit|Write"` or `"Task"` was written to `.codex/hooks.json` as is. Codex calls those tools `apply_patch` and `collaborationspawn_agent`, so the hook, a `strength: refuse` one included, never fired, with no warning. Now `Edit`, `Write` and `MultiEdit` become `apply_patch`, `Task` and `Agent` become `collaborationspawn_agent`, and `Bash` stays. A Claude tool Codex has no hook-visible tool for (`Read`, `Grep`, `WebFetch` and others) gets a `CX8-tool` warning; a matcher left with no name gets no entry.

### [fix] A slow gate check cannot outlast the Codex hook timeout (R-3)

- Every guard was registered with a 120 second hook timeout and the gate wrapper had no deadline of its own. A check longer than that, or a gate with `timeout: 10m retry: 2`, was cut off by Codex, and Codex lets a timed-out call run. Now a guard's hook timeout is never below its gates' worst case (timeout x attempts, plus the pauses, plus a margin), and the hook command cuts the run 10 seconds before that timeout and exits 2 ("ran past its deadline"). `validate --target codex` warns (`CX9-timeout`) when a gate's worst case raises the hook timeout.
- Where neither GNU `timeout` nor `gtimeout` is installed (stock macOS), the deadline is kept by a shell watchdog: it stops the check and everything the check started, and the guard exits 2.

### [fix] Codex before-agent.sh reads agent_type trimmed and lowercased (R-12)

- `before-agent.sh` on Codex compared `agent_type` exactly, so `" Reviewer "` missed the `reviewer` case and the spawn went through. It is now trimmed and lowercased the way the spawn guard reads it.

### [fix] A gate between two agents holds the second agent on Codex (R-1)

- A gate `after: writer, before: reviewer` compiled only to a `SubagentStop` hook on `writer`. Codex cannot block a `SubagentStop`, so `reviewer` was spawned whether the gate passed or failed, while `AGENTS.md` said "Enforcement: hook". Now `before-agent.sh`, a `PreToolUse` hook on `collaborationspawn_agent`, refuses to spawn `reviewer` (exit 2) until the gate script passes. The `SubagentStop` hook still runs and only reports. A gate after the last agent, with no agent after it, is now described as reported only. The Codex gate wrapper also changes to the project root first, so its check is found from the session's folder.

### [fix] A Codex rescaffold removes the topology's stale hook groups (R-8)

- When `.codex/hooks.json` was merged, a group counted as the topology's only when a whitespace-separated word of its command equalled a generated script path. A Codex command names the script after a root expression (`"$(git rev-parse …)/.codex/scripts/<t>/x.sh"`), so no group was ever recognized: moving a gate's anchor left both `SubagentStop` groups, and a removed gate kept firing. Now any `.codex/scripts/…` path in the command counts, the stale group is replaced, and the user's own groups stay. Claude Code ownership is unchanged.

### [fix] A Codex guard blocks when its script is not found (R-2)

- A guard's hook command was `bash "$(git rev-parse --show-toplevel || pwd)/.codex/scripts/<t>/<guard>.sh"`. From a nested git repository, or from a subfolder of a project outside git, that path does not exist, bash exits 127, and Codex lets the call run. The command now starts at the repository root (else the current folder) and climbs until it finds the script; if it is nowhere above, it prints the reason and exits 2, and any other non-zero exit of the run becomes 2.

### [fix] `guard --target codex` writes the gate's check script and names Codex (R-9)

- `guard --target codex` did not write the check script a gate runs (such as `.codex/scripts/render-check.sh`): the gate wrapper names it by a bare root-relative path, which the discovery did not read, so in a fresh project the gate always failed with "exit code 127". It also printed "checked against Claude Code". Now the check is written as a failing stub when it is missing (an existing one is never overwritten) and the output carries the Codex CLI version line.

### [fix] A verified-list entry counts only with a clean suite (R-10)

- `spec/claude-code/verified.json` entries were checked for shape only, so an entry whose suite had `failed: 12`, or had no suite at all, made that Claude Code version read "verified". Now an entry counts only when its proof carries a suite with `failed: 0`; any other entry is reported as a problem and the version reads unverified.

### [fix] The Codex surface map knows where the guards live (RW-2, CX-9)

- Guard scripts are written to `.codex/scripts/<topology>/`. The surface map now reads that folder as a name (`.codex/scripts/*/*.sh`) and holds one entry for it, graded `check`: a guard that is not where `hooks.json` points exits 127, and Codex lets the call through.

### [feature] Gates on Codex (CX-9)

- On `--target codex`, gates are now enforced by hook scripts instead of a note to run them by hand. `before-action.sh` refuses a script step's command until the gate's ledger shows the step finished ok, also inside an `&&` chain. `before-agent.sh` runs the gates that stand before an agent when Codex spawns it, and `gate-<id>.sh` runs when the agent it follows stops. All are registered in `.codex/hooks.json` with a 120 second timeout.
- Codex lets a command through when a hook exits 1, exits 127 or times out; only exit 2 blocks. Every generated guard turns its own failure into exit 2 with a reason: a missing `jq`, input that is not JSON, an unreadable ledger, a gate script that cannot start. A gate script nobody has written yet fails instead of passing.
- A project hook is skipped until it is trusted, with no warning, so every Codex guard is unverified. `AGENTS.md` now names the `/hooks` step. agentopology never writes a trust entry.

### [feature] The human gate on Codex, without "ask" (CX-11)

- Codex cannot ask from a `PreToolUse` hook, so an approval step before an agent now blocks the spawn with exit 2 until `.codex/state/approvals.jsonl` ends with an approval record for that step. The message gives the person the command that writes it. No generated script prints `ask`.

### [feature] `guard --target codex` (CX-17)

- `agentopology guard <file.at> --target codex` writes only the guard scripts and their `.codex/hooks.json` entries into a project built by hand. The user's own hook entries and files stay, `AGENTS.md` is not touched, and a second run changes nothing. `hooks.json` now merges on a scaffold too, instead of being reported as a conflict.

### [feature] Conformance tests for Codex, tiers A to D (CX-15)

- A new test file checks every example and fixture against the Codex contract with no model call: the config and agent files against a key list, `hooks.json` against the hook contract (now including timeouts and anchored script paths), every generated command hook run from a subfolder, and, where `codex` is installed, `codex execpolicy`, `codex sandbox` and `--strict-config`.

### [fix] Codex inventory test used Claude model names (CX-18)

- The Codex inventory test scaffolded fixtures that name Claude models, which the Codex scaffold refuses; it now uses a Codex model name.

### [feature] Surface map for Claude Code (RW-1)

- `spec/surface/claude-code.surface.json` lists everything the Claude Code binding writes or relies on: hook events, handler fields, payload fields, frontmatter keys, settings keys, permission modes, written paths and CLI flags. Each entry names its contract page, where the binding uses it, the test that proves it, and what breaks if it changes. A test scaffolds `kitchen-sink.at` and the session-agents fixture and fails on any generated item that has no entry, so the map cannot fall behind the binding.

### [feature] Surface map for Codex, with a schema snapshot (RW-2)

- `spec/surface/codex.surface.json` does the same for the Codex binding, and `spec/codex/config.schema.json` is a copy of Codex's `config.toml` schema at tag `rust-v0.168.0`. A check compares every key and value in a generated `config.toml` with the schema. A known mismatch is excused only by a `knownDrift` entry that carries a ticket id; any other mismatch fails.

### [feature] The tick: new versions from the npm registry (RW-3)

- `scripts/release-watch/tick.mjs` reads the registry entry for Claude Code or Codex and lists every stable version published since the last one seen, by walking the registry's publish times. Skipped version numbers do not matter, and for Codex, prerelease and per-platform builds are dropped. It exits 0 when nothing is new, 10 when there are new versions, and 2 when the registry answer cannot be read.

### [feature] The red-green gate (RW-11)

- `scripts/release-watch/red-green.mjs` checks that a planted test fails at its own commit and passes at HEAD, working in a clone. It exits 1 and says "never red" when the test already passes at its own commit.

### [feature] The verified Claude Code versions become a list with proofs (RW-7)

- `spec/claude-code/verified.json` lists the Claude Code versions the output was checked on, each with a proof (run id, date, suite counts). `validate` and `guard --check` no longer mark an installed version as unverified when it is on the list. An entry with no proof does not count. With no readable list, the single `VERIFIED_ON` version behaves as before.

### [feature] Permission rules for Codex (CX-13)

- `settings { allow / ask / deny }` entries of the form `Bash(command *)` now scaffold `.codex/rules/<topology>.rules` as `prefix_rule(...)` calls: deny is `forbidden`, ask is `prompt`, allow is `allow`. Each rule carries a `match` example (for `git push`, `git push origin main`) that Codex checks when it loads the file; where the `codex` binary is installed the test runs `codex execpolicy check` against it. When one command is in two lists, the strictest decision is written.
- An entry a command-prefix rule cannot hold (a tool name such as `WebFetch`, a wildcard inside the command) is reported with a warning instead of dropped.
- When agents differ in `permissions`, the one warning now names the agents that set the strictest policy. A new "The `codex` binding" section in `docs/bindings.md` describes what is written and what is not.

### [feature] Hooks compile to .codex/hooks.json (CX-8)

- On `--target codex`, the topology's `hooks {}` block is now registered in `.codex/hooks.json` in the shape Codex reads. Before, the scaffold wrote no hook file at all. A hook with `run: "exit 2"` is written as that command; it no longer becomes a stub file named `exit` that exits 0.
- Every hook command finds the repository root at run time, so it works from a subfolder. Scripts are written executable, and a stub for a `strength: refuse` hook exits 2 until it is written. Two scripts with the same file name no longer collide.
- A hook's `if: "Tool(pattern)"` is kept through a small `at-if.sh` filter, so a hook meant for `rm -rf *` does not block every shell call. Without `jq` the filter blocks.
- Hooks Codex cannot run get a warning and no entry: an event Codex lacks (for example `Error` or `Notification`), a `prompt`, `agent`, `http` or `mod` handler, an `if:` that is not `Tool(pattern)`, or run text that is prose. A matcher on an event that ignores it warns. Per-agent hooks are listed as not expressible, since Codex hooks are project-wide. Codex skips a new hook until it is trusted with `/hooks`, and scaffold says so.

### [feature] Scheduled jobs that run Codex (CX-20)

- On `--target codex`, a schedule job with `carrier: cron` (or none) that runs an agent now scaffolds an executable `scripts/schedule-<id>.sh` and a `crontab.fragment` line. The script runs `codex -a never exec --sandbox <mode>` with an explicit sandbox: the agent's, the project's, or `read-only`.
- A job whose agent writes files while no sandbox is named gets a warning that `codex exec` is read-only by default, so the job cannot write. A job with another carrier (cloud, launchd, calendar, session) or one that runs an action gets a warning and no script. `carrier: session` with `survives:` is still an error (V125).

### [feature] Codex says what it cannot express (CX-23)

- `validate` with a Codex target (and `scaffold --target codex`) now gives one warning for each field Codex has no key for: sampling settings (temperature, max tokens, top-p, top-k, stop, seed), a thinking token budget, output format, max turns, log level, fallback chain, rate limit, circuit breaker, background and isolation on an agent, the same sampling settings under `defaults`, and `providers`. Each warning names the field, why, and which agents set it.
- Temperature and max tokens are no longer left as commented-out lines in `config.toml`.
- A zero-drop test holds every field set in `kitchen-sink.at` to "found in the Codex output" or "on the not-expressible list".

### [feature] Full MCP tables for Codex (CX-14)

- A Codex `[mcp_servers.<id>]` table now carries every field of the server: `env` as its own table, `args` and tool lists as arrays, `startup_timeout_sec` as a number, and `bearer_token_env_var` for a URL server. The Claude Code `type` key is left out.
- A new `matcherProblem` for Codex hooks flags the dotted `mcp.server.tool` matcher (a Codex hook sees `mcp__server__tool`) and a matcher on an event that ignores it.

### [feature] Honest Codex agent files and model names (CX-5)

- `scaffold --target codex` now refuses a Claude model name (`opus`, `sonnet`, `haiku`, `fable` or any `claude-*`) on an agent or the orchestrator. It prints which agent uses which name, exits 1 and writes nothing. It does not pick a Codex model for you; set one such as `gpt-5.2`.
- A Codex agent file no longer holds `sandbox_mode`, `mcp_servers` or `nickname_candidates`: Codex ignores the first two in an agent file and does not document the third. An agent that sets `sandbox` or `mcp-servers` gets a warning naming it, and `validate` with a Codex target gives the same warnings. MCP servers are written once in `config.toml`.
- A prompt with `"""`, backslashes or quotes now survives in the agent file: it is written as a literal TOML string, or escaped when it holds `'''` or a control character, and `sync` reads it back either way.

### [fix] A Codex config.toml that Codex 0.156.1 accepts (CX-4)

- `approval_policy` is now `on-request` or `never`. The words `supervised`, `plan`, `confirm`, `interactive` and `suggest` used to become `untrusted`, which Codex no longer takes. With agents that differ in `permissions`, the strictest policy applies to the project and scaffold warns.
- Providers are no longer written as `[[providers]]` tables: Codex has no such key, and a project config may not set `model_providers`. Scaffold warns that they are dropped. The keys `disable_response_storage`, `history.max_conversations` and `max_depth` are no longer written either, and `[agents]` uses `max_concurrent_threads_per_session`.
- Extension keys now sit at the top of the file instead of inside the last MCP table, MCP `env` maps are written as `[mcp_servers.<id>.env]`, and the Claude Code `type` key is no longer copied into MCP tables.

### [feature] The version line and installed mark per target (CX-1)

- `targets` and `scaffold --target codex` now print the Codex line ("checked against Codex CLI ...") and, when the installed `codex` is not the checked version, a mark such as "installed 0.999.0: unverified". The Claude Code output is unchanged.
- The line and the mark come from one per-target seam, `src/conformance/index.ts`, so a new target adds one entry instead of another branch in the CLI.

### [feature] Inventory and coverage for a Codex project (CX-18)

- `inventory` and `validate --inventory` now read a Codex project: the agent files under `.codex/agents`, the skills under `.agents/skills`, each entry in `.codex/hooks.json`, the files under `.codex/rules`, and the MCP servers in `.codex/config.toml`. Before, only the `.claude` tree was walked, so a Codex project counted 0.
- Coverage maps them to the `.at` the same way as Claude Code files. A hook added by hand shows as unmapped.

### [feature] Flow lens: what sits on the flow is drawn where it sits (VZ-5)

- A gate is a chip on the edge it guards, with its grade (shape and word) beside it. Human steps sit in one "seats" lane, stores sit on a rail with a read tick and a write tick per agent, and jobs and triggers carry flags on the step they start.
- Loop, wait and error edges differ by dash pattern and by a word ("loop max 3", "wait 30s", "error"), not only by color. Agents that share a phase open collapsed into one stage block; a click opens it.
- Every label in the page is at least 11 px. `kitchen-sink.at` opens with 13 blocks and no overlapping boxes.

### [feature] Sessions lens (VZ-6)

- Places are titled boxes holding their session agents, with subagents nested under the session that spawns them. Each talk edge carries its message kind as a chip, `talk: hub` draws the hub, `decides:` shows a badge, and a session with no talk guard on disk is hatched "unguarded". The send and spawn guard grades come from the embedded facts.

### [feature] Seats lens (VZ-8)

- One row per human step and per declared decision: where it sits, what it releases, its timeout and on-timeout, and its grade from `guard --check`.

### [feature] Coverage lens (VZ-9)

- Mapped, unmapped and missing by kind, read from `validate --inventory` (including `inventory { roots }`, the `--user` tree and `needs`). A click on a number lists the items. With no project folder the lens reads "not checked". The embedded inventory facts now carry the per-kind lists, the roots, the user tree and the outside needs.

### [feature] Index lens with the source embedded (VZ-10)

- Every node, edge, store, command, hook, job, skill, tool and decision is a row with its line in the `.at`. The `.at` text is embedded in the page (escaped like the rest of the data) with an anchor per line, and a click on a row, or `#lens=index&line=12`, jumps to it.

### [fix] A visualizer test no longer depends on the installed Claude Code version (VZ-7)

- The check that the page counts `unverified` guards ran under the verified version, where nothing reads unverified. It now loads the facts under a version that is not the verified one.

### [feature] Verified on Claude Code 2.1.323 (VO-323)

- The version the output is checked against is now 2.1.323. A live check on that version, recorded on 2026-11-13, found that PreToolUse fires on the SendMessage tool and exit code 2 blocks the call, that `claude --agent X` resolves `.claude/agents/X/AGENT.md`, and that the SendMessage tool input carries the target as both `to` and `recipient`.
- `guard --check` now grades the talk guard and the spawn guard `refuse` when the installed Claude Code is 2.1.323, and still `unverified` on any other version or when none is installed.
- The hook contract snapshot was regenerated from the live docs page: no contract change, only the version and fetch date moved. The text-output snapshots changed only in the version line (36 lines).

### [fix] The package no longer depends on itself (N47)

- `package.json` listed `agentopology ^0.2.0` under `dependencies`, so every install pulled an old copy as a nested package. The entry and its lockfile record are removed, and a test fails if the package ever lists its own name again.

### [feature] Inventory covers folders a run reads, other .at files, and the user's home (T-08)

- A top-level `inventory { roots: ["harness/", "scripts/"] }` block lists extra project folders. `inventory --at <file.at>` and `validate --inventory` list every file under them (kind `file`) and report a root that does not exist as missing. An absolute path, a home path or `..` in a root is a validate error (V128).
- `inventory --user` and `validate --inventory ... --user` add `~/.claude/agents`, `skills`, `commands` and the hooks in `~/.claude/settings.json`, tagged user-level and counted apart from the project.
- `validate --inventory DIR a.at b.at` prints the per-file numbers, then one union number in which a live thing is mapped when any file maps it. With one file the output is unchanged.

### [feature] Declare what lives outside the repo (L-4)

- A top-level `needs { memory: "~/path"  connectors: [name]  user-skills: [name] }` block parses, round-trips and is listed by `validate` under "declared outside the repo". A bad memory path or a path used as a name is a validate error (V129).
- With `validate --inventory ... --user`, a declared user skill (`~/.claude/skills/<name>`) and a declared memory path count as mapped when they exist and as missing (exit 1) when they do not. Connectors cannot be checked locally and print `not checked (account connector)`.
- README and spec now say 129 rules (V1-V129).

### [feature] The visualizer is one offline page with themes, lenses and deep links (VZ-4)

- The generated page holds no web address at all: dagre and every script are inline, fonts are the system stack, and there is no `<link>` or `@import`. A test reads the page text and fails on any `http://` or `https://` outside comments.
- Light and dark themes come from CSS variables, follow `prefers-color-scheme`, and a Theme button sets `data-theme` (remembered in the browser when storage allows).
- A lens bar (Flow, Sessions, Guards, Seats, Coverage, Index): Flow and Guards work, the others show a "coming" panel. A headline strip shows seven facts: agents, session agents, gates, guards graded refuse / hope / none, coverage, validate results and the Claude Code version stamp. Facts that were not read say "not checked".
- The legend is built from the projection rules table (one row per node kind, plus the guard grades), not written by hand.
- `#node=<id>` opens that node's inspector and `#lens=guards` opens a lens (they combine with `&`). Search matches ids and labels.

### [feature] A Guards lens that grades every guard without relying on color (VZ-7)

- Each gate, approval step, permission rule, talk guard and spawn guard gets a chip from the embedded `guard --check` facts. Shape, word and color go together: refuse is a solid square, hope a hollow circle, none a dashed outline, and unverified is the refuse shape with a "?".
- A ledger lists every graded item worst first (none, hope, detect, unverified, refuse) and lists hooks that no step ties to under "untied".
- Clicking a headline number such as "hope 3" shows only those items.
- With no project folder every chip reads "not checked". The counts in the page equal the counts `guard --check` prints for the same folder.

### [feature] A small AGENTS.md for Codex that keeps your own text (CX-6)

- The Codex `AGENTS.md` no longer holds agent prompts. Each prompt lives in `.codex/agents/<id>.toml`, between the prompt markers, so a 40-agent topology scaffolds an `AGENTS.md` well under Codex's size cap.
- The generated part of `AGENTS.md` sits between `agentopology:begin` and `agentopology:end` markers. A re-scaffold replaces only that block and keeps any text you wrote above or below it.
- `sync` reads prompts from the agent files. An `AGENTS.md` scaffolded earlier is still read for agents the files do not cover.

### [fix] Codex skills are written where Codex reads them (CX-7)

- Each skill is now `.agents/skills/<id>/SKILL.md` with `name` and `description` frontmatter. Nothing is written under `.codex/skills/` any more, since Codex never loaded those files.
- A skill with `disable-model-invocation` also gets `agents/openai.yaml` with `policy.allow_implicit_invocation: false`.

### [feature] One guard-script library for the bindings (CX-10)

- The before-agent, before-action and gate-wrapper scripts, and the session spawn, talk and prompt-log guards, are now built in `src/bindings/lib/guards.ts` from a platform record (project-dir variable, folders, hook payload field names, whether a hook can ask). The Claude Code scaffold is byte-identical to before for every example and fixture, held by a golden test. A Codex platform record builds the same guards with no `CLAUDE_PROJECT_DIR` and no `.claude` paths in them. Nothing is wired into the Codex binding yet.

### [feature] The Codex contract: constants, snapshots and a drift watch (CX-2)

- A new module holds what Codex CLI 0.156.1 documents: the 14 hook events, which of them ignore a matcher, which handler types run and which are skipped, the legal approval and sandbox values, and the keys a project config may not set. `checkHooks` reports an unknown event, a matcher on an event that ignores it, and a handler that Codex skips.
- Snapshots of the hook contract, the config keys and the feature flags are committed under `spec/codex/`. A test holds the constants to them, and `scripts/codex-drift.mjs` compares the snapshot with the live hooks page and prints each difference.
- The four URL keys that a project config may not set are not yet listed, because the page that names them could not be read when this was written.

### [feature] Codex probe pack (CX-3)

- `spec/codex/probes.json` and `spec/codex/probes.md` record ten facts about Codex CLI 0.156.1 that its docs do not state, each with its evidence and the date it was measured.
- Exit 2 from a `PreToolUse` hook blocks a shell command in `codex exec`. Exit 1, exit 127 and a timeout let the command run, with no warning.
- File edits reach hooks as `apply_patch`, and a subagent spawn as `collaborationspawn_agent`. A subagent's `agent_type` is the `name` in its agent file.
- Project hooks do not run without hook trust, and Codex does not say it skipped them. `.codex/` is read-only to the agent under `workspace-write`.
- `codex exec --strict-config` is the one command that rejects unknown config keys before any model call. A message sent with `codex queue` reaches an interactive session as a plain `UserPromptSubmit`, and never reaches a `codex exec` session.
- `scripts/codex-probes.sh` reruns the probes in temp repos. It is off unless `CODEX_LIVE=1`.
- A `[CX-3]` test fails unless every probe P1 to P10 has a dated record with a Codex version.

### [fix] README rule count matches the registered rules (I011)

- README.md and spec/validation.md now say 127 rules, the number the validator registers (V1-V127).

### [fix] Text-output snapshots no longer depend on the machine (I011)

- Setting `AGENTOPOLOGY_CLAUDE_VERSION` to a version (or `none`) replaces the `claude --version` check, so validate and guard --check print the same lines on every machine. The text-output snapshot test sets it to the verified version, and the snapshots are re-recorded with the padded strength column.

### [feature] People who are away, and approvals that expire (T-09)

- A top-level `person <id> { away: "2026-01-31..2026-02-14" }` block. A `human` takes `who: <person>`.
  Validate warns for every human step whose person is away today or later, with what the step does on
  timeout (V126). An unknown person or a malformed window is an error (V127).
- A human may declare `valid: "YYYY-MM-DD..YYYY-MM-DD"`. `step check` refuses a step that human guards
  once today is past the window.

### [feature] Schedule jobs say what carries them and what they survive (T-06)

- A schedule `job` takes `carrier: session | cron | launchd | cloud | calendar` and
  `survives: pane-close | reboot | away`. Other values are a validate error (V124).
- `carrier: session` with any `survives:` is an error (V125): a session cron dies with its session and
  after 7 days.
- `inventory` now lists launchd plists and crontab lines whose command points into the project folder,
  counted as the machine's and never required.

### [feature] Machines, and home-folder paths are an error (T-07)

- A top-level `machines { machine mac { os: macos } }` block, and `machine:` on session agents, schedule
  jobs and stores. A machine that is not declared is a validate error (V122).
- A hook, gate, tool or action command with an absolute path into one person's home folder
  (`/Users/<name>/`, `/home/<name>/`, `C:\Users\`) is a validate error (V123), because it only works
  on that machine.

### [feature] A store can name its owner (T-10)

- `owner: <agent>` on a store. If two agents that are not the owner both write the store, validate now
  reports an error (V121) that names both. An owner that is not an agent is an error too. Stores with no
  owner are checked as before.

### [fix] The validate inventory knows the talk log (N44c)

- `validate --inventory` no longer lists `.claude/state/talk.jsonl` as unmapped when the topology declares
  session agents, since the generated talk guard writes it.

### [feature] The visualizer page carries check results (VZ-3)

- `validate`, `guard --check`, `validate --inventory` and the Claude Code version stamp now have
  functions that return their results as data. The terminal text is unchanged, pinned byte for byte
  over every example.
- `visualize --dir <project>` reads those results and embeds them in the page, keyed by item id, with
  the sha256 of the `.at` source and the time they were read. A node's panel shows them under "Checks".
  With no `--dir`, every fact reads "not checked".

### [feature] `visualize` is quicker to run (VZ-11)

- With no file argument, `visualize` draws the only `.at` in the current directory, or in
  `.claude/topologies/`. With none or several it says so and lists them.
- The page is written to `~/.cache/agentopology/visualize/` unless `--output` is given.
- New flags: `--no-open` (write only), `--no-check` (ignore `--dir`, every fact "not checked") and
  `--print-summary` (node counts and facts on stdout). `visualize-brain` also honours `--no-open`.
- The browser opener is `open` on macOS, `xdg-open` on Linux, `start` on Windows and `wslview` under WSL.

## [0.10.1] - 2026-11-13

### [fix] Review fixes for the 0.10.1 session and import work (N44e)

- The talk guard now accepts a flow target whose id has letters, digits, `_` and `-` (for example a subagent `code_reviewer` or `Helper2`), matched exactly as declared. Session ids stay lowercase kebab-case and match exactly.
- `place:` must be lowercase (`a-z`, `0-9`, `-`, starting with a letter); `place: Ops` is now a V113 error instead of silently dropping the session from `.claude/sessions.md`.
- `talk: hub <name>` with a name that is not a session agent, and any `talk:` line that is not `all` or `hub <name>`, is now a V113 error naming the line.
- `scaffold`, `plan`, `export`, `brief` and `visualize` now resolve imports the way `validate` does, so a missing or mismatched import is reported instead of compiled over.
- The visualizer escapes `<`, `>`, `&`, U+2028 and U+2029 in the data it inlines, so a field containing `</script>` can no longer break out of the page script.
- An `import` that follows a brace inside a quoted string or a `#` comment is no longer dropped.
- Import checking reads and validates each imported file once, so a deep diamond of imports finishes quickly, and an imported `fragment` is checked for parse errors and its own names only, not as a whole topology.
- `guard --check` pads its strength column to the longest strength word, so `unverified` lines up.
- The README rule count check counts every registered rule, including those that take options.

### [fix] Talk guard reads both target fields (N44d)

- Claude Code sends the `SendMessage` target twice, as `to` and `recipient`. The talk guard now uses `to`, or `recipient` when `to` is absent, so a send that names only `recipient` is checked against the talk edges instead of slipping through. When both are present and differ after removing a `[ref]` suffix, trimming and lowercasing, the send is refused with `talk guard: to and recipient disagree` and logged as refused.

### [fix] Session guards: second review follow-ups (N44c)

- A `permission-mode` with characters other than letters, digits and `-` is no longer written into `.claude/sessions.md` or `scripts/start-sessions.sh`, even with `--allow-invalid`; the launcher is not written and the session gets no start line.
- The launcher skips a session only when herdr lists its exact name, so `lane-build-old` no longer hides `lane-build`, and an error banner that names the ids does not count as a listing.
- The talk guard refuses to write through a hard-linked `talk.jsonl`. When the log cannot be written (hard link, symlink, or an unwritable folder) an allowed send still goes through and prints `talk log not written` to stderr.
- A `[ref]` suffix on a `SendMessage` target must be only letters, digits, `_` and `-`, otherwise the send is refused. The spawn guard now refuses `subagent_type: false` and any other non-string value. A place name with unsafe characters is not printed in the `sessions.md` heading. `scaffold --prune` removes a stale `scripts/start-sessions.sh` when no session agents remain.

### [fix] Every documented import form is read, at the top of the file too (T02b)

- `import reviewer from ./review.at`, the quoted path, `import linter from registry:@org/linter@1.2.0`
  and `import auditor from ./audit.at sha256 "<hex>"` (also `sha256: "<hex>"`) now parse. Before, only
  `import "./f.at" as x` did and the others were dropped with no message.
- Imports written above the `topology` line are read, and checked like the ones inside it.
- A line starting with `import` that matches no form is a V8 error ("unrecognized import form").
- A registry import is not read from disk; `validate` prints a warning "registry import not checked".
- Converting a topology back to `.at` writes the `from` form and keeps every import.

### [fix] The import check reads the imported files (N43, T-02)

- `validate` now resolves each local `import "./f.at" as x` relative to the importing file. A missing file,
  a `sha256` that does not match the file, an import cycle, and any error inside the imported file are
  errors (V8) and make `validate` exit 1; errors from the imported file are shown with its path.
  Validating a string with no file path cannot resolve anything, so it warns `imports not checked`.

### [feature] Warn on bare model aliases when models are pinned (L-3)

- With `pin-models: true` at the top level, V119 warns once per alias (`opus`, `sonnet`, `haiku`, `fable`)
  used as a `model:`: an alias resolves differently over time, so use the exact id for a pinned run.
  `inherit` and exact ids are fine. Without `pin-models`, nothing changes.

### [feature] The visualizer draws session agents (VZ-1)

- A `runs: session` agent wears a "session" mark, and each `place` is a titled box around its sessions.
  Talk edges show their `[message: ...]` kind, and the inspector lists runs, place, decides and permission mode.
- Stores sit in their own band under the flow, and memory edges are faint until you hover them.
- On load the graph fits to the screen, including the place boxes, and leaves room for the open panel on narrow windows.

### [fix] Manual agents stay in the flow layout (N45)

- Agents with `invocation: manual` are laid out with the rest of the flow and keep their edges. Only a manual agent
  with no flow edge at all is parked at the side. The page data now carries every parsed field, including `runs`,
  `place`, `decides`, `permissionMode`, an edge's `message` and the topology's `decisions`.

### [fix] Session guards: fail-open and wrong-refusal fixes (N44b)

- The spawn guard now blocks when its input is empty, `{}` or has no object `tool_input`; a spawn with no `subagent_type` is still an ordinary spawn. It lowercases and trims the value, strips a `<prefix>:` namespace, refuses a non-string `subagent_type`, and refuses a `name` that equals a session id.
- The talk guard strips a trailing ` [ref]` (the mark ListAgents adds to duplicate names) before matching, lets a session message its own flow targets (such as its subagents) and `main`, refuses any target that is not `a-z`, `0-9` and `-` (so a newline or NUL no longer passes), and logs every refusal, including an oversize target or an unreadable payload.
- The prompt log writes `kind: unknown` for empty or malformed input, and ignores leading whitespace before `<cross-session-message`.
- The guards log to `$CLAUDE_PROJECT_DIR`, or to the project root found from the script's own path, and never append through a symlink. `talk.jsonl` is a trail, not evidence: whoever can write files can edit it, and `guard --check` says so.
- `guard --check` grades a spawn or talk guard `none` when the script no longer holds its generated `exit 2` line and `jq -er` read.
- The launcher single-quotes every value it interpolates and is not written when a place or session id is not `a-z`, `0-9` and `-`. It skips a session herdr already lists, warns that a rerun duplicates sessions when herdr cannot list them, and says in its header that the herdr subcommands are unproven.

### [feature] Session agents: scaffold, guards and launcher (N44b)

- `scaffold --target claude-code` writes each `runs: session` agent's file as for any agent, plus
  `.claude/sessions.md` with one start line per session (`AT_SESSION=<id> claude --agent <id> -n <id>`,
  with `--permission-mode` when declared) and `scripts/start-sessions.sh`, a plain POSIX launcher that
  opens one herdr tab per `place:` and one pane per session, or prints the start lines when herdr is not installed.
- A spawn guard (a PreToolUse hook on `Agent|Task`, `onFailure: "block"`) refuses to launch a session agent as a subagent.
- A talk guard (a PreToolUse hook on `SendMessage`) refuses, with exit 2, a send to a session the current
  session has no talk edge to. The current session is `$AT_SESSION`, set by the start line. When it is unset
  the send passes with a note on stderr; when it is set the guard fails closed on any parse error.
  Every send is appended to `.claude/state/talk.jsonl` as `allowed`, `refused` or `unguarded`.
- `guard --check` lists both guards and grades them `unverified`, not `refuse`, until the conformance facts
  mark PreToolUse on `SendMessage` and `Agent` as proven. Under the talk guard it says that a send through a
  terminal command, a shared file or a session outside the repo is not seen.
- Other targets (codex, cursor, claude-workflow) validate and draw session agents and print
  "session agents: experimental, not compiled".

### [feature] Decision seats see typed versus arrived input (T-04)

- New rule V120: an agent with `decides:` that a talk edge points at gets a warning, because a decision can
  arrive there as a message. Messages are not refused by keyword. Instead scaffold writes a UserPromptSubmit
  hook for that agent's session (active only when `AT_SESSION` is its id) that logs each prompt to
  `.claude/state/talk.jsonl` as `kind: arrived` when it starts with `<cross-session-message` and `kind: typed`
  otherwise, so a human-gate script can tell the two apart. The hook never blocks.

### [feature] Session agents: grammar and validate (N44a)

- An agent takes `runs: session` (beside `subagent`, `inline` and `fork`), `place: <name>`,
  `decides: [<decision>, ...]` and `permission-mode: default | acceptEdits | plan | bypassPermissions | auto`.
  A session agent's id is also its session name and message address, so validate requires it to be kebab-case.
- Who may talk is the flow edges between two session agents. `talk: all` and `talk: hub <name>` write them;
  the parser expands them into plain edges, so `export --format json` shows ordinary edges.
  `[message: ticket | report | ask]` on an edge records what crosses it. Talk edges are not checked as loops.
- New validate rules V113 to V118: field forms, `talk not declared: unguarded` when sessions have no talk edge,
  a `hub` pattern broken by an edge, two agents claiming one decision (and a topology-level `decisions: [...]`
  entry nobody claims), fields a session ignores (`background`, `skills`, `permissions`), and a talk edge between
  sessions in different permission modes.
- `agentopology docs agent` and `docs flow` cover the new fields; `parse -> serialize -> parse` keeps them.

### [fix] The version line reports the Claude Code that is actually installed (T-01)

- `validate` and `guard --check` now read `claude --version` (once per run, 3 second limit) and
  print `installed X: unverified` when X is not the version the output was checked against. If the
  version cannot be read, they print `unknown version: unverified`; if there is no `claude` on
  PATH, they print `Claude Code not installed`. Exit codes do not change. In `guard --check`, every
  line that reads "refuse" carries the same mark when the installed version is not the verified
  one. With the verified version installed, the output is unchanged.

### [feature] The visualizer builds its page data in one place (VZ-2)

- `src/visualizer/project.ts` holds `project(ast, facts)`, a pure function from the parsed topology to the data the page draws. Each node kind has one row in a rules table that lists the fields it carries and the fields it drops on purpose; a node kind with no row is drawn with a default rule that keeps every field.
- A new test checks that every field on every parsed node and edge in `kitchen-sink.at` and the examples reaches the page data or is claimed as dropped in the table, and that it fails on a field nobody claimed. Fields the page used to leave out silently (for example `timeout`, `join`, `custodianOf`, `extensions`, group members) now reach the page data.
- The page looks the same: the node ids and edges in the data are unchanged for every example.

## [0.10.0] - 2026-11-11

### [fix] A guarded script step is found inside a chained command (N42)

- `before-action.sh` tested whether the whole Bash command started with the step's command, so
  `cd repo && ./tool publish ep1`, `true; ./tool publish ep1` and `make x || ./tool publish ep1`
  ran the step with its gate unmet while `guard --check` reported the gate as refuse. The command
  is now split on `&&`, `||`, `;`, `|`, `&` and newlines; each segment, after a leading `(`, `{`,
  `then`, `do`, `exec`, `time`, `nohup`, `env` and `VAR=value` are stripped, is matched against the
  guarded steps, `unit-from` reads from that segment, and every matching segment is checked.
  Quoting is not parsed, which can only over-block. A command that runs the step indirectly
  (`bash -c`, `eval`, a script that calls it) is still not seen; `guard --check` now says so.
- The segments are read from a separate file descriptor and every child in the loop runs with stdin
  from `/dev/null`, so a gate's check script that reads stdin cannot swallow the later segments.

### [fix] `@types/node` is a devDependency

- It was missing, so on a fresh `npm ci` `npx tsc --noEmit` failed with hundreds of TS2307 errors
  (`Cannot find module 'node:fs'`); machines that had it installed by accident never saw it.

### [feature] `step check`: a script step asks whether its gates hold

- `agentopology step check <file.at> <step-id> [--unit U] [--dir D]` exits 0 when every gate with
  `before: <step-id>` holds, else 1, naming each failing gate and why. Hooks guard Claude Code
  sessions only; a script run from a terminal or a scheduler calls this at its start (`by: code`).
- A gate holds when its ledger's last record for the `after:` step (same unit, if given) is ok,
  and its `run:` (if any) exits 0 from D. A gate with neither is unsatisfiable ("nothing to
  check", the case V110 warns about). A step no gate guards exits 0 ("no gate guards <step>");
  a step that is no node exits 1. It reads ledgers and runs check scripts; it never writes.
- The ledger line format is documented in the gate grammar and the `gate` docs topic.

### [feature] Guards for script steps: a gate before an action refuses in Claude Code

- A gate whose `before:` is an action with `commands:` used to compile to nothing (V25: "invoke
  it from your playbook"), so a session ran the step whether or not the gate held. It now
  compiles to `before-action.sh`, a `PreToolUse` hook on `Bash` with `onFailure: "block"`.
  Exit 2 when the ledger has no ok record for the gate's `after:` step and unit, or its
  `run:` check fails; a command that matches no guarded step goes through.
- New, all optional: action `unit-from: "<regex, one capture group>"` reads the unit from the
  command line; top-level `records { record trace { path: "logs/{unit}/trace.jsonl" } }`; gate
  `ledger: <record id>` (omitted, the only record). A ledger is JSON Lines:
  `{"step": "<node id>", "unit": "<unit>", "ok": true, "at": "<ISO time>"}`, appended by the
  step's own script; the last line for the step decides.
- V110 (no ledger and no `run:`: nothing to check), V111 (bad `unit-from`), V112 (unknown
  ledger, unsafe record path, ambiguous ledger). V25 no longer warns for a compiled gate.
- `guard --check` reports such a gate as refuse by hook, noting it covers Claude Code sessions
  only.

### [breaking] Claude Code is the supported target; four bindings are removed

- **Removed:** `gemini-cli`, `copilot-cli`, `openclaw` and `kiro` (bindings), and the OpenClaw
  importer (`import --target openclaw`). `scaffold --target <one of them>` now says it was removed
  in 0.10.0 and to use 0.9.x. 125 tests that covered them went with them.
- **Experimental:** `codex`, `cursor` and `claude-workflow` stay. `targets` labels them and
  scaffold warns, because they are not verified against their platform the way claude-code is.
  `claude-workflow` is kept: it is a Claude target, the theory runs used it, and it feeds the
  hybrid seam in an example hybrid harness (now `examples/hybrid-release.at`).

### [feature] `guard --target claude-code` writes only the guards

- `agentopology guard <file.at> --target claude-code [--dir D] [--dry-run]` adds the enforcement
  to a project built by hand: the hook scripts, the gate wrappers they call, the checks the gates
  run, and the `hooks` and `permissions` of settings.json, merged with what is there. Nothing
  else scaffold writes (agents, skills, commands, rules, .mcp.json, CLAUDE.md) is touched.
- The set is found by following script paths from settings.json, so a new hook script is picked
  up with no list to update. Edited scripts and checks that are no longer stubs are kept and
  named. A rerun changes nothing. It ends with the `guard --check` report and exits like it.

### [feature] `validate` says which Claude Code it was checked against

- Every `validate` run ends with `checked against Claude Code 2.1.319 (supports 2.1.295 and later)`,
  on success, warnings, errors and `--inventory`. `scaffold --target claude-code` and
  `targets` print it too. The numbers are read from the conformance constants, never retyped.

### [feature] Claude Code's hook contract as a snapshot, and a drift check

- `spec/claude-code/hooks-contract.json` is extracted from the hooks reference page: 33 events,
  10 with no matcher support, the matcher rules, the five handler types' fields, and each
  "Requires Claude Code vX". `hooks-contract.2.1.295.json` is the same contract at the minimum
  supported version, derived by dropping what needs a newer one.
- Tests hold the code to the snapshot. They found `CwdChanged` missing from the no-matcher
  events, where a matcher is silently ignored. They also check that every event and handler
  field the binding writes exists at 2.1.295.
- `npm run drift` fetches the page and exits 1 when the contract moved. `--write` accepts it.

### [fix] Hook matchers are checked the way Claude Code reads them; `if:` and `exit 2` work

- **V107 (error):** a matcher that can never match. Examples: permission-rule syntax
  (`Bash(rm -rf *)`; the argument filter belongs in the new `if:`), the dotted
  `mcp.chrome.*`, a bare `mcp__chrome`, and a regex that does not compile. An `if:` on an event
  that is not a tool event is also an error, because Claude Code never runs that hook.
- **`if:` on hooks:** a permission-rule filter on the tool's arguments, written on the
  settings.json handler and in agent frontmatter.
- **`run: "exit 2"`** (any shell builtin) is written as the command itself. It used to scaffold
  a stub named `exit` that exited 0, so the hook never blocked. **V108 (warning):** `exit 1`
  does not block; only exit 2 does.
- **V109 (warning):** a hook with `strength: refuse` guards an MCP server, but its matcher misses
  a tool of that server the topology names. `validate --inventory` also checks the tool names
  an owner lists in inventory.json (`"kind": "mcp-tool"`) and prints them as `matcher gaps`.
- The hooks doc topic taught `matcher: "Bash(rm -rf *)"` and `run: "exit 1"`. Neither works:
  the example now uses `matcher: "Bash"`, `if:` and `exit 2`, and gives the timeout in seconds.

### [feature] `inventory` and `validate --inventory`: how much of a project the .at accounts for

- `agentopology inventory [<dir>]` prints, as JSON, what is live in a project: every file in the
  .claude tree with its sha256, each settings.json hook handler, each .mcp.json server and each
  package.json script. It writes nothing; save it as `inventory.json` and settle its tags by hand.
- `agentopology validate <file> --inventory <dir or inventory.json> [--dir <project>]` adds
  `coverage: k of n live things are in the .at`. A live thing is accounted for when scaffold
  would write it from the .at, or the .at points at it (`file:`, a hook's or gate's `run:`, a
  tool's `script:`, `at:`, an mcp server, a skill folder it declares). It lists what nothing
  accounts for (unmapped, a warning) and what the .at points at that is not on disk (missing,
  exit 1). Things tagged `e` (the platform, the machine; `settings.local.json` is suggested as
  one) are counted apart.

### [feature] `guard --check` reads citations and credits cited guards

- A gate's `at: "path:line"` is checked on disk: the file exists, the line is in it, and `match:`
  appears within 5 lines. A citation that no longer holds is `none`, and the command exits 1, so a
  refactor that moves or removes the check is caught.
- A gate the binding gives no hook (one between two script steps, for example) is credited by the
  hook its edge cites, `[guard: lock-bash]`, when that hook is in `.claude/settings.json` and
  declares `strength:`. The credit reads "cited, not proven", and its `bypass:` is printed.
- An edge's written `[strength: none]` is reported as declared, never as a failure.
- A declared hook's settings entry is attributed however its interpreter is spelled, so it is no
  longer listed as a hand-built hook.

### [feature] Enforcement written in the file: `strength`, `by`, `at`, `match`, `bypass`, `guard`

Optional and additive, so no existing file changes meaning.
- A gate takes `strength: refuse | detect | hope | none`, `by: code | hook | settings | gate`,
  `at: "path:line"` (the code that refuses), `match:` (the text expected there) and `bypass:`.
- A hook takes `strength` and `bypass`.
- A flow edge takes `[strength: none]`, `[at: "story/SKILL.md"]` and `[guard: lock-bash]` or
  `[guard: [a, b]]`, alone or after `when`. An absence of enforcement can now be declared.
- New rules (106 in all): **V104**, the words; **V105**, a `guard:` names a declared hook or gate;
  **V106**, `at:` is a safe project-relative `path[:line]`, and `match:` needs an `at:`.
  validate never reads the project; checking the cited lines is `guard --check`'s job, which comes next.

### [feature] `guard <file> --check`: what a project enforces today

Read-only. For every gate, approval step and deny/ask rule, it works out what the claude-code
binding compiles it to, then looks in the project:
- **refuse**: its hook or settings rule is on disk, anchored to `$CLAUDE_PROJECT_DIR`.
- **none**: the binding generates one, but the project lacks it or names its script by a relative
  path. The command exits 1.
- **hope**: no Claude Code hook exists for it (an advisory gate, inline delegation, a gate between
  two script steps); only the playbook's prose asks for it.

Notes flag a check script that is a stub or missing (it blocks every run), a before-agent entry
without `onFailure: "block"`, and an approval step that `claude -p` denies. It prints
`enforcement: k of m steps refuse` and lists any hook in settings.json it can't tie to a step: a
hand-built guard it can't credit yet. That waits for the strength and `guard:` citation work.

### [fix] Generated hooks run from any directory (conformance v0)

Claude Code runs a hook in the session's current directory, not the project root, and that
directory moves when Claude changes directory. Every generated hook command except the
before-agent guard named its script by a relative path (`bash .claude/skills/...`). Run from a
subfolder, the script was not found, the shell exited 127, and 127 does not block, so the hook
was skipped. That included every SubagentStop gate. Measured on all 13 corpus topologies: 16 hooks.
- Every generated hook command is now `bash "$CLAUDE_PROJECT_DIR/.claude/skills/<topology>/scripts/<file>"`.
- New: `src/conformance/claude-code.ts` holds Claude Code's hook contract (33 events, matcher
  support, handler fields, `onFailure`, the PreToolUse decision schema), checked against the docs
  on Claude Code 2.1.319. `e2e/conformance.test.ts` scaffolds every example and fixture, checks
  their hooks against it, and runs each command hook from a subfolder with the event's JSON on stdin.
- Found and left open: a hook `run: "exit 1"` scaffolds a stub that exits 0 (N29), and a matcher
  in permission-rule syntax, such as `Bash(rm -rf *)`, never matches a tool name (N30).

## [0.9.2] - 2026-11-09

### [fix] Generated gates fail closed

Claude Code blocks only on exit 2. On 0.9.1 a gate could fail open: with `CLAUDE_PROJECT_DIR`
unset `before-agent.sh` exited 1, with `jq` missing 127, and a gate script nobody had written
exited 0. In each case the agent launched with its gate and approval step skipped.
- `before-agent.sh` and every gate wrapper now exit 2 on any error. An EXIT trap with a
  done-flag catches it, because macOS `/bin/bash` 3.2 hands the trap status 0 after an
  unset-variable error.
- A gate script stub exits 2 until it is written, the way action stubs already fail.
- The guard's settings entry sets `onFailure: "block"` (Claude Code 2.1.295+), so a hook that
  cannot start or times out blocks too. Older versions may ignore the field (undocumented);
  the scripts' own trap still holds there.
- Logging and observability hooks are unchanged: exit 2 there would stop a subagent from
  finishing.

## [0.9.1] - 2026-11-09

### [fix] A gate's `description:` is read, as V96 asks

- V96 tells you to put a gate's explanation in `description:`, but the parser never read that
  field on a gate, so 0.9.0's V102 rejected it. It's now a gate field: parsed, kept by import
  and serialize, and documented in `docs gate` and the grammar. Found on the content harness:
  all 17 V102 errors in its two files were gate descriptions.

## [0.9.0] - 2026-11-09

**Breaking: a file with a field or block the parser does not read now fails `validate` (V102),
and so does an agent's or gate's `behavior:` other than `advisory`/`blocking` (V103).** On 0.8.0
those names were dropped in silence and validate passed. This release also carries the import fix
(PR #27): import reads only what it needs on a repo root, always ends, and recovers the flow.

### [fix] An unknown field or block is an error, never dropped in silence

- **V102 (error).** Every field and block name in a node (orchestrator, agent, action, gate,
  human, group), `meta`, a hook, job, artifact, tool or skill, and every topology section, must be
  one the parser reads. A typo (`modle:` → "did you mean `model`?"), a field of another node type
  (`produces:` on an action → "it is a field of agent") or a block the language does not have
  (`contract c1 { }`) used to vanish from the AST while validate printed "All validation rules
  passed" and scaffold dropped it. On 0.8.0, 15 of 17 probe cases were dropped this way.
- **V103 (error).** An agent's or gate's `behavior:` must be `advisory` or `blocking`; any other
  value was emitted into the scaffold unchecked.
- **Breaking for files that relied on the silence.** A file with a name the parser ignored now
  fails validate with exit 1. Words the language does not have yet (`serves`, `strength`,
  `state`) are errors until they are added.
- **The docs taught dropped forms.** `docs agent` listed 15 fields by their AST names
  (`maxTurns`, `onFail`, ...), which the parser ignores; they are now the names you write
  (`max-turns`, `on-fail`). `docs artifacts` showed `NAME { }`; the parser reads
  `artifact NAME { }`. `kitchen-sink.at` and two examples carried such fields and are fixed
  (an orchestrator `plan:` and an undeclared `hooks { PostToolUse { } }` that the binding
  already synthesizes are removed).
- Not checked yet (open findings N25, N26): an agent's `role:` is still not read, and V102 does
  not look inside free-form blocks (`settings`, `env`, `memory`, `providers`, `flow`, ...).

### [fix] Import works on a repo root, and recovers the flow

- **Reads only what it needs.** For Claude Code: the root `.claude` folder's Markdown, JSON and
  shell files, `.mcp.json`, and `.at` files. `.worktrees`, `.claude/worktrees`, `dist`, `build`,
  `coverage` and the source tree are never read, so an `agents/x.md` in the source is no longer
  an agent. A skill the author named `build` is kept. Symlink cycles end. On a client repo with
  31 agents 0.8.0 tried to hold 1,061,701 files (16.4 GB), ran 656 seconds and was terminated with
  no output; the read is now 143 files.
- **Always ends, and says why.** An unreadable, broken or oversized (over 5 MB) file is skipped and
  named; a link at the root is not followed out of the project; past 256 MB the read stops with a
  message and exit 1. The first line prints before any read.
- **Recovers the flow.** A `.at` that shares at least 2 agents, and half of its own, supplies its
  edges, actions, humans, gates and orchestrator; an agent's own file wins. That repo's export
  went from `edges: []` to 52 edges. Scaffolding such an import wires the recovered gates into
  settings.json (hooks are added, the user's are kept).
- **Says what it does not know.** The CLI and the top of the `.at` report sources used and
  skipped, agents wired and unknown, agents declared with no file, and possible handoffs. No edge
  is invented; names that match only by suffix are reported, not mapped.
- An agent with no `model:` imports as `model: inherit`; a gate heading with a note gives a clean id.

## [0.8.0] — 2026-10-30

### [feat] The language says what Claude Code can do, out loud

- **How a node runs is on the node.** `runs: subagent | inline | fork`: `inline` and `fork`
  compile to a skill (fork with `context: fork`, a fresh context), never a subagent, and the
  playbook says how to call each. `independent: true` marks a critic or judge: it is told to
  judge only its artifacts, the playbook hands it nothing else, and it cannot run inline.
  New rule **V101**.
- **Hooks are a typed union:** `command`, `prompt`, `agent`, `http` (`url:`), `mcp_tool`
  (`server:`, `tool:`), `mod`, plus `async:` on a command and `model:` on a judge. New rule
  **V100**: each type has its fields, and a judge sits on an event Claude Code runs judges for.
- **First-class fields.** Agent: `color`, `initial-prompt`, `omit-claude-md`; `thinking`
  compiles to Claude Code's `effort` (one word for one concept, as decided in 0.5.0). Skill:
  `when-to-use`, `argument-hint`, `arguments`, `paths`, `shell`, `model`, `thinking`,
  `disallowed-tools`. Import reads them first-class.
- **Permission warning.** An agent asking for `acceptEdits`, `auto`, `dontAsk` or
  `bypassPermissions` is warned at scaffold: a subagent cannot widen its session's permissions.

Proven by `e2e/compile.test.ts` (every phase-4 test fails on 0.7.0) and live L3 (real Claude Code
registers `runs: fork`/`inline` nodes as skills, and holds back a skill with `paths:`).

## [0.7.0] — 2026-10-30

### [fix] What scaffold writes, Claude Code reads as meant

Each of these compiled to config Claude Code skipped, misread or never fired. Proven by
`src/__tests__/e2e/compile.test.ts` (each test fails on 0.6.0) and live tests L3 to L5 in
real Claude Code.

- **Gates after an action or a human are enforced.** They compiled to no hook. When `before:`
  names an agent, the gate now runs in a PreToolUse hook on the Agent tool: a failing gate
  blocks the launch and shows its reason.
- **A human node is an approval step.** It compiled to an agent file Claude Code ignores. Now
  Claude Code asks the user before launching the next agent, and the playbook says to ask.
- **Hooks fire.** `type: prompt` hooks compile to prompt handlers (were commands); `AgentStop`,
  `AgentStart`, `ToolUse` and `Error` map to Claude Code events; a regex matcher no longer
  breaks the agent file's YAML.
- **Agents register.** A manual agent keeps its description (Claude Code skips one without);
  `confirm` and `bypass` map to real permission modes; `yes`-like values are quoted; a model
  Claude Code does not have is omitted with a warning.
- **MCP and permissions.** A url server gets `type: http`; MCP names convert in whole-server,
  wildcard and dotted forms, permission rules included; `ask` rules are emitted.
- **Run lines.** The script is the word after the interpreter, never an argument; a project
  script runs in place from the project root with its arguments.
- **Skills, actions, tools, schedules.** A skill's `prompt:` reaches the model (and a skill may
  hold a `prompt { }` block); an action's `commands:` are emitted for every kind; a tool's stub
  goes where its `script:` points; schedules run headless from the project root and `every:`
  converts to cron.
- **The topology context** goes to `.claude/rules/<topology>.md`, so it never competes with the
  project's own CLAUDE.md.
- **Sync is a fixed point.** The prompt is marked in the agent file; scaffold then sync no longer
  grows the prompt, and an edit comes back once.
- `scaffold --dry-run` shows what a settings.json or .mcp.json merge would change, key by key.
- Output is byte-stable (no date in stubs).

### [feat] Two new rules

- **V98** (error): a `gate`, `hook`, `tool`, `job`, `command` or `level` written outside its
  container block was dropped with no message.
- **V99** (warning): an agent's `skills:` / `mcp-servers:` or a skill's `agent:` names nothing
  the topology declares.

## [0.6.0] — 2026-10-30

### [fix] Scaffold only changes what it owns (#22)

Scaffold used to write every file on the first run, so it overwrote hand-written files and,
through a symlinked skill folder, wrote into a second repository. Now every run goes through
one plan: a file scaffold did not create is a conflict and is kept (unless `--force`), a
symlink is never written or deleted through, an unsafe path aborts the whole run, and
`--prune` deletes only files still exactly as scaffold left them. `settings.json` merges:
every permission and every hook the user wrote is kept. Each topology keeps its own manifest
(`.scaffold-manifest.<source>.json`). Settings `env` no longer carries `${VAR}` text, which
Claude Code applied literally ("Invalid API key" in 6 of the 10 examples). New rule **V96**:
a `run:` must be a command, not prose.

### [feat] A hand-built system comes into .at without losing anything (#23)

New field **`file:`** on any agent, human, group, skill or command: the internals live in that
hand-written file, and scaffold never generates it. `import` sets it on every file no scaffold
created. On this repo's own `.claude/`, import then scaffold now leaves 73 of 73 files
byte-identical, also with `--force` (before: 0 of 72 identical, 37 missing). New rule **V97**
(`file:` is a project-relative path). `--allow-invalid` compiles despite errors; `--force` alone
no longer does. Import fixes: permissions read from `permissions{}`, `tools: Read, Grep` string
form, flowless agents imported as `invocation: manual`, and an agent's extensions no longer
leak into project-wide settings. A hook's own script is never overwritten.

### [feat] Hooks can be Mods; project hooks run by their interpreter (#20, #21)

`type: mod` hooks scaffold as a Claude Code plugin (rules **V94**, **V95**). A project hook
runs through `$CLAUDE_PROJECT_DIR` by its interpreter, and a `run:` may name one.

### Tests

A regression suite indexed in `spec/testing.md`, and live tests (`AT_LIVE=1`) that start real
Claude Code on every scaffolded example and on an imported hand-built project: 12 of 12 pass.

## [0.5.2] — 2026-09-23

### [fix] A gate is drawn on the path it guards

A gate declared with both `after` and `before` was placed at the midpoint between its two
nodes with no lines at all, so it looked like it floated free of the flow; two gates on the
same pair were drawn on top of each other. Seen on a real 28-node topology.

Now the visualizer draws `after → gate` and `gate → before` (following `afterAll`/`beforeAll`),
places gates that share a pair side by side in declaration order, and highlights a gate's
`before` anchor on hover. The planner was always right (`agentopology plan` splices gates
correctly); only the drawing was wrong.

Proven by `src/visualizer/__tests__/gate-connectors.test.ts` (runs the page's own script in a
node vm), with two red controls: connectors off → the path assertion fails; the side-by-side
offset off → the overlap assertion fails.

## [0.5.1] — 2026-08-26

### [feat] The validator teaches the fix, not just the failure

The package shipped 41 documentation topics and 93 validation rules, and the two
never met. A rule told you a field was wrong; nothing showed the right form.

Now every rule whose fix is a **shape** carries a worked example, printed inline
when it fires:

```
  ERROR [V89] agent "a" uses `prompt:` as a key-value field, but agent
              prompts must be a `prompt { }` block — this value is ignored

  ── how to write it ──────────────────────────────────

  [V89]
    agent analyzer {
      model: sonnet
      prompt {
        Read the diff at workspace/pr-diff.md.
      }
    }
    → agentopology docs agent
```

Deduplicated by rule and capped at three, so a badly broken file cannot produce
more teaching than output — twelve V90 errors get the lesson once. `plan` shows
the same on its refusal path.

**Why in the tool rather than beside it:** a skill loads its prose up front
whether you need it or not and only works on one vendor. A CLI serves the right
snippet at the moment of the mistake, in a few hundred bytes, on Codex and
Gemini too.

### [feat] `agentopology docs --agent`

The compact path for writing a `.at` from scratch: **2 KB**, against 104 KB for
`docs --all`. The shape, plus the five rules that actually bite in practice.
Nobody should load a hundred kilobytes to write one topology.

### [test] The lessons cannot teach a mistake

Every example a lesson presents as correct is parsed and validated, and must be
clean under the rule it teaches. It caught two on its first run: V13's snippet
referenced undeclared nodes (a V13 violation), and the agent guide's own
topology failed V15 — it did not cover the `approve` branch, which is trap #4
in the guide's own list.

1513 tests.

## [0.5.0] — 2026-08-26

Everything here came from **first contact**: a session that orchestrated ~20
agent lanes, wrote the remaining four days as a topology, and filed one bug and
seven capability asks. Their framing set the direction — *"closing the loop
between the plan, the run, and the next plan."*

Two of the seven were built as asked. Two were built differently, because
measuring them first showed the ask was aimed at the wrong thing. Two were
deferred. One turned out to be already solved.

### [feat] `plan` reports what the filesystem says about each step

A topology already declares what each role writes. Whether those files exist on
disk **is** the run state. `plan` now reports per step — outputs present,
outputs missing, or undecidable — and stops there.

Deliberately **not** built: a run-state sidecar, `status:` fields in the `.at`,
or `--resume`. A sidecar would record *"I finished"*; the filesystem records
*"the artifact exists"*, and only the second survives a crash between stamping
and writing. And skipping a step on this evidence would make a judgement on the
agent's behalf and hide it — a truncated file counts as present. **Report, don't
decide.** The brief says so and points at `git log`.

The invariant this protects: **a `.at` file never contains a fact about a
specific run.** A test asserts the brief never mutates the AST.

### [feat] V93 — an edge should declare what crosses it

For an edge between two agents that both declare paths, `writer.writes ∩
reader.reads` must be non-empty. Empty means the receiver runs after the sender
with none of its output.

A **warning**: passing a result inline is legitimate. Skipped entirely when
either side declares nothing — undecidable, not wrong.

It fired on 26 edges across six real files on its first run, and two were
genuine design bugs **in our own examples**: `simple-pipeline`'s revision loop
sent the writer back to revise without giving it the review, and
`data-processing`'s back-edge re-ran the synthesizer without the report. Both
fixed.

### [feat] Multi-anchor gates — `after: [a, b, c]`

One declaration, many attachment points, one gate step per anchor. A repeated
verification ritual copied per lane will drift, and the whole value of a ritual
is that it is identical everywhere.

Not an agent capability — the brief gets the same gate steps and `scaffold`
emits the same hook entries either way. What changes is that they can no longer
disagree.

`gateAnchors()` is the single normalisation point. An audit mapped every read
site first: TypeScript catches four, and ~18 more would have accepted an array
**silently** — a hook matcher shipping `["a","b"]` into `settings.json` where the
hook simply never fires, `g.after === id` never matching, ~12 lookups inside the
visualizer's untyped browser-JS template literal, and a serializer emitting
`after: a,b` which re-parses as the single id `"a,b"`. Each class now has a test
verified to fail without its fix.

### [fix] Cursor's `preToolUse` matcher named the wrong node

Found by byte-diffing all 10 examples across all 8 bindings before and after:
1208 of 1213 files identical, and the five that differed were a bug. Cursor
selects `preToolUse` **because** `before` is set, then matched on `after` — so
`after: writer, before: reviewer` emitted `matcher: "writer"` and the pre-hook
fired before the wrong node.

### [feat] `thinking` gains `xhigh`, and `max` stops collapsing

The ask was an `effort` field beside `model`. `AgentNode.thinking` already
existed and codex already compiled it to `model_reasoning_effort` — so `effort`
would have been a second word for one concept. Instead:

- `xhigh` added to the enum
- codex mapped `max → "high"`, leaving `max` and `xhigh` with no distinct value
- `claude-workflow` emitted nothing for reasoning and never read
  `agent.thinking` at all — on the one target whose runtime accepts `effort` as
  a literal `agent()` option. It now emits it.

A test asserts no `effort` field exists, so the decision cannot quietly reverse.

### [fix] An error back-edge no longer breaks reachability *(shipped in 0.4.3)*

### Honest KPI result

The derived-run-state target was **missed**, and the miscalibration was mine: a
70% target set from an *agent-level* measurement, applied to a *step-level*
metric that also counts actions, gates and human nodes — undecidable by
construction. On the steps evidence can apply to it is 77%; across all steps,
39%.

More importantly: **0% on the topology of the person who asked for it**, because
it declares no `writes` anywhere. The feature works as designed and is useless
without the data.

1505 tests, up from 1474. 93 rules, V1-V93 contiguous.

## [0.4.3] — 2026-08-26

### [fix] An error edge pointing backward made the whole downstream unreachable

Reported on first contact: a 13-step topology that **validates clean** rendered
eleven nodes as "unreachable from the entry point".

`-x->` error edges were skipped by back-edge detection but still handed to the
ranker. So `take6-staging -x-> oom-fix` looked like a genuine cycle
(`oom-fix → take6-staging → oom-fix`), Kahn could not rank it, and everything
downstream fell to depth −1.

An error edge is an exception route, not a step — a catch, not part of the happy
path. It no longer contributes to ranking at all.

The report attributed this to the second root of a parallel fan-out. That part
was already correct; there is now a test pinning it so the fix cannot regress it.

### [docs] `docs/FEEDBACK-FIRST-CONTACT.md`

The seven capability asks from that session, each checked against what the
package actually supports today and ranked by value over cost. Two are small
(multi-anchor gates, an `effort` field), one is Phase 2's first honest step
(edge schema compatibility — the schemas already exist, nothing compares them),
and the largest names an axis the roadmap did not have: **a topology can
describe intention and has no vocabulary for what actually happened.**

## [0.4.2] — 2026-08-26

### [feat] `agentopology/plan`, `/render`, `/resolve` subpath exports

The interpreted-mode modules were shipped but not reachable — `package.json`
exported only `.`, `./parser`, `./bindings` and `./visualizer`, so
`import { buildExecutionBrief } from "agentopology/plan"` threw. Now exported,
with `renderBriefMarkdown` re-exported from `plan` so both halves are one import.

### [docs] README covers both lifecycles

The hero and the "What It Does" diagram still described a one-way compiler:
`.at` in, platform configs out. It now shows the fork — `scaffold` to files, or
`plan` to a brief your coding agent enacts — plus a section on interpreted
execution with a real render, the four questions the brief answers, and the
three autonomy notches.

Corrected a stale "29 built-in rules" (it is 92) and the programmatic API
example, which imported subpaths that did not exist.

### [test] The README is now checked against the package

`src/docs/__tests__/readme-sync.test.ts` fails if the README imports a subpath
`package.json` does not export, states a rule count the validator disagrees
with, points at a `docs` topic that does not exist, or contains an `.at` snippet
that does not parse and validate. Documentation drift is not a discipline
problem — it is a missing test, the same shape as the spec drift fixed in 0.4.0.

## [0.4.1] — 2026-08-26

### [fix] `plan` dropped every gate from the rendered flow

`0.4.0` held nodes with no edges out of the terminal spine, so a topology's
manual-invocation agents would not read as concurrent work. But a **gate** never
appears in an edge either — it binds through `after`/`before`, which is the
whole reason `resolve/order.ts` splices them by anchor. So every gate was
classified as "declared but not in the flow" and vanished from the render.

Only the ASCII render was affected. The execution brief, the order resolver and
all 8 bindings were correct throughout — a scaffolded gate still compiled to its
hook.

The test that should have caught this compared the gate's line POSITION against
the agent it gates. When the gate was dropped from the spine, its name still
appeared in the "declared but not in the flow" line further down, so the
positional assertion held. It now asserts the gate is present in the spine by
its glyph, before comparing anything.

## [0.4.0] — 2026-08-26

### [feat] `agentopology plan` — interpreted mode, a second lifecycle for a topology

A `.at` file has always compiled to a persisted harness. It can now also be
**enacted directly**, by the coding agent already in your session, with nothing
written outside the session scratchpad.

```bash
agentopology plan <file>.at --mode plan|execute|auto [--task "..."] [--brief]
```

The premise: **the host coding agent is already the runtime.** It plans, spawns
subagents, runs them in parallel, reads files, retries and re-plans. It does not
need generated agent files to do any of that. So `plan` does not run anything —
a CLI cannot spawn subagents. It is a **linter and an orderer**: it validates
(the agent that wrote the file can write an illegal one), applies the spec's
defaults, resolves execution order, and emits an **execution brief** — a
Markdown program in eleven fixed sections that a host agent follows.

The brief resolves what a host would otherwise guess: handoffs as
`writes ∩ reads`, what each reader **must not** read, which same-step roles are
mutually blind, gate tiers, loop budgets, and every declaration that cannot be
honoured at runtime. Nine ambiguity kinds are detected statically and pre-filled,
each carrying a concrete `.at` edit that would remove the guess.

Not a replacement for `scaffold`. The same declaration, two execution backends —
a **lifetime** choice, not a strategy one. `agentopology docs interpreted-mode`
explains which to reach for.

### [feat] Terminal flow renderer, and two new export formats

`plan` prints an ASCII flow graph ranked by real execution order — gates spliced
where their `after`/`before` puts them, exclusive branches drawn as branches with
their conditions, loops with their budgets. Also available as
`--format ascii` and `--format brief`.

### [fix] Gates were ranked as graph sources

Gates bind through `after`/`before`, never through edges, so their in-degree is
zero and a topological sort ranks them **first**. On `examples/code-review.at` a
post-review gate sat next to the entry action. Execution order is now resolved
with gates spliced at their anchors, including gate-to-gate anchors regardless of
declaration order.

### [fix] An unphased agent no longer sorts differently on every target

Seven consumers each chose their own sentinel for an undeclared `agent.phase`:
`MAX_SAFE_INTEGER` in claude-code and claude-workflow, `999` in gemini-cli, `0`
in openclaw, kiro, mermaid and the markdown exporter. The same topology put the
same agent **first on four targets and last on three** — the exact failure
"write once, deploy to any platform" exists to prevent. `src/resolve/phase.ts` is
now the single definition, and a test fails if any consumer reintroduces its own.

### [fix] `codex` no longer defaults `permissions` to the strictest policy

The spec's default is `autonomous`, which maps to Codex `on-request`. The binding
used `supervised`, which maps to `untrusted`. Omitting the field produced an
agent that asked permission for everything.

### [fix] `settings.json` hook merging was written, tested, and unreachable

`deepMergeSettingsJson` handles union-merged permissions, merged env, and
topology-owned hooks. The scaffold pipeline routed `settings.json` to the generic
JSON merge instead, which cannot update an existing `hooks[event]` array and can
never remove one — so scaffolding a hook into settings that already declared that
event silently dropped it.

### [feat] Four new validation rules, and the spec now tracks the validator

| Rule | Catches |
|---|---|
| **V89** | `agent.prompt` written as `prompt: "path"` — the string form belongs to `skill`. Two shipped examples did this on eight agents, pointing at a directory that never existed, and those agents scaffolded with their own description as their entire instruction set. |
| **V90** | A field value that swallowed the next field. Fields are one per line; the grammar never said so, and `{ model: sonnet retry: 3 }` made `model` the string `"sonnet retry: 3"`. |
| **V91** | A required field satisfied by a parser-injected placeholder. V7 is named *Model required* and passed on an orchestrator with no model, because the parser had substituted `"unknown"`. |
| **V92** | An edge's attributes split across two brackets. `[when ...] [max N]` produced the condition string `a.verdict == fail] [max 3`, silently. |

`spec/validation.md` documented 35 rules while the validator implemented 89 —
fifty-four existed only in source, because nothing compared them. The table is
now generated from the registry and a test fails if the two ever diverge. **92
rules, V1-V92, contiguous.**

### [feat] `docs/KPIS.md` and `docs/PRIOR_ART.md`

29 metrics across four layers, each naming the instrument that measures it. And
the priority record: `agentopology@0.1.0` was published to npm on **2026-03-19**,
four months before "graph engineering" became the name for the practice. Three
copy-pasteable commands let a stranger verify that without trusting us.

### Notes

Every fix above was found by **using the tool on itself** — a stranger's topology
run through `plan`, and a review topology whose verifier stage reproduced each
claim against the real CLI before accepting it. 22 findings acted on. The compile
path is unchanged: all 8 bindings produce byte-identical output.

1467 tests, up from 1351.

## [0.2.5] — 2026-05-30

### [feat] `claude-workflow` binding — compile topologies to the Claude Workflow runtime

The first binding whose output **executes** (a Claude Workflow script) rather than
only configuring a project. `agentopology scaffold <file>.at --target claude-workflow`
compiles the **deterministic fan-out phases** of a topology — the phases whose
agents are marked `extensions { claude-workflow { execution: workflow } }` — into a
`<topology>.workflow.js` (a Claude Workflow tool script using `export const meta`,
`parallel()`, `agent()`, the `schema` option, and `isolation: 'worktree'`). It also
emits a `<topology>-SEAM.md` (the Blackboard hand-off contract), a
`<topology>-README.md` (human-node split), and a `<topology>-LOSSY-REPORT.md` that
loudly lists every primitive that could not be translated — nothing is dropped
silently. `human` nodes force a workflow split; session-fixed concerns
(permissions, providers) are reported, not faked.

### [feat] Hybrid model — `claude-code` host + `claude-workflow` rung from one topology

One `.at` topology can compile to **two coupled targets at once**. `claude-code` is
the **host** (the event-driven layer: agents, hooks, the Blackboard, concurrent
observability, the human/gate/branching nodes). `claude-workflow` is the embedded
**deterministic rung** (the parallel fan-out phases). They couple through the
Blackboard files (`memory.workspace`): the host launches the rung and observes its
writes live via a `PostToolUse` hook — giving concurrent observability the Workflow
runtime cannot express on its own. The `claude-code` binding is now hybrid-aware:
agents marked `execution: workflow` are NOT emitted as host subagents (the rung owns
them); instead the host emits the launch glue + the observe hook + a "Hybrid run
order" block in `CLAUDE.md`.

The hybrid is **opt-in and backward-compatible**: a topology with no
`execution: workflow` marker compiles to pure `claude-code`, unchanged.

### [internal] `src/bindings/lib/seam.ts` — single source of truth for the seam

The `claude-code` and `claude-workflow` bindings share one module for the seam
namespace, the `execution: workflow` predicate, the generated-artifact filenames,
and the Blackboard root — so the two halves cannot drift.

### [test] hybrid end-to-end test

`hybrid-e2e.test.ts` compiles both bindings from one `.at` file and proves they
compose: agents partition cleanly, both agree on the seam, the generated
`workflow.js` is valid ES module syntax (`node --check`), the host wires the
observer, and the LOSSY report names the human split. (1310 tests total.)

### [docs] strategy + mapping

- `docs/AT_VS_WORKFLOW_STRATEGY.md` — why `.at` is the runtime-agnostic standard
  (Terraform-for-agents) and Claude Workflow is its first compile target.
- `docs/bindings/claude-workflow-mapping.md` — the complete bidirectional mapping:
  every `.at` primitive + design pattern classified CLEAN / LOSSY / UNREPRESENTABLE.
- An example hybrid harness topology (now `examples/hybrid-release.at`).

## [0.2.4] — 2026-05-19

### [feat] `orchestrator { delegation: inline | subagent }` field (#7)

Topologies can now declare how the orchestrator runs the agent nodes. The
new `delegation` field on the orchestrator block has two values:

- `subagent` (default): the orchestrator spawns each agent via the platform's
  subagent / Task-tool mechanism. Each agent runs in its own context window.
  On claude-code, `SubagentStop` hooks fire and gates compile to those hooks
  (the behavior every version up to 0.2.3 shipped).
- `inline`: the orchestrator drives every agent step in its own session
  context. Agent `AGENT.md` files are read as prompt fragments by the main
  session; no subagent is ever spawned via Task.

### [fix] claude-code: suppress dead `SubagentStop` hooks in inline mode (#7)

When `orchestrator.delegation: inline` is declared, the claude-code binding:

- Skips emitting `SubagentStop` hooks for every gate, regardless of whether
  the gate's `after:` target is a registered subagent_type — no subagent
  ever runs, so the hook would never fire.
- Skips emitting any global `hook { on: SubagentStop }` / `SubagentStart`
  declaration with a one-line warning explaining why.
- Updates the gate-wrapper script header to say "Enforcement: NOT wired as
  a SubagentStop hook (orchestrator.delegation is 'inline'). Invoke this
  script from your /<topology> playbook at the right step."
- Adds a **"Gates to invoke (inline-orchestrator)"** section to each
  generated `.claude/commands/<trigger>.md` listing every blocking gate
  with a copy-pasteable `bash` invocation, the `after:` step name, and the
  `on-fail` semantic. This is the cheat sheet pattern the youtube-flywheel
  topology in `agentopology-content` arrived at by hand.

Default behavior is unchanged: topologies without `delegation:` continue
to compile gates to `SubagentStop` hooks exactly as in 0.2.3.

### [feat] New validator rule V87 — orchestrator delegation enum

`orchestrator.delegation` must be one of `subagent` or `inline`. Any other
value (including typos like `inlined`, `delegate`, etc.) is a hard error.

### Migration

If your topology drives every agent step from a slash-command playbook and
the scaffolded `SubagentStop` hooks have always been dead config for you,
add one line to your `orchestrator` block:

```at
orchestrator {
  model: opus
  delegation: inline   // <-- add this
  handles: [start, finish]
}
```

After re-scaffolding, your `settings.json` will have no `SubagentStop`
entries and the trigger playbook (e.g. `.claude/commands/<topology>.md`)
will contain a ready-to-paste cheat sheet for invoking each gate at the
right step.

## [0.2.3] — 2026-05-19

### [refactor] Lift `shellStub` to shared `src/bindings/lib/stub.ts` (#4)

The `shellStub()` function was duplicated across five binding files
(claude-code, codex, gemini-cli, kiro, openclaw) and declared but unused in
cursor.ts. Each copy now lives in one place: `src/bindings/lib/stub.ts`.
Cursor's dead copy was removed.

### [feat] Machine-readable `AGENTOPOLOGY_STUB` marker in stubs (#4)

Every script produced by `shellStub()` now contains the literal line
`# AGENTOPOLOGY_STUB — fill this in before relying on this script`. The
marker is:

- A comment, so it never affects script behavior at runtime.
- Removed by the user once they implement the script — that single action
  flips the file out of "stub" state for all downstream tooling.
- Pinned by a unit test so downstream gate-runners or CI scripts can match
  on it reliably across minor versions.

Use `isStubContent(content)` from `agentopology/bindings` (exported via
`src/bindings/lib/stub.ts`) to detect stubs programmatically.

### [feat] `agentopology scaffold` reports stub count and paths to stderr (#4)

After a successful scaffold run, the CLI now emits a yellow warning to
stderr listing every generated file that contains the `AGENTOPOLOGY_STUB`
marker. Output looks like:

```
  3 stub(s) need implementation before this topology can run:
    · .claude/skills/yt/scripts/validate-brief.sh
    · .claude/skills/yt/scripts/qa-render.sh
    · .claude/skills/yt/scripts/check-platform-auth.sh
  Search for "# AGENTOPOLOGY_STUB — fill this in before relying on this script" — remove that line when each script is implemented.
```

stdout is unchanged so existing automation that captures the file list keeps
working.

### [feat] New `agentopology stubs <project-dir>` command (#4)

Scan an already-scaffolded project for unimplemented stubs. Walks the
directory (skipping `node_modules`, `.git`, `dist`), greps each file for the
marker, and prints a sorted list. Exits 1 if any stubs remain, 0 if clean —
designed for CI:

```sh
# In your CI pipeline:
npx agentopology stubs ./
```

### [fix] claude-code: gate SubagentStop hooks only emitted for agent/group targets (#3)

The `SubagentStop` hook's `matcher` field is matched against the registered
`agent_type` (the name of a `.claude/agents/<name>/AGENT.md` subagent). Only
`agent` and `group` nodes scaffold a frontmatter-bearing AGENT.md and register
as subagent_types — `human`, `action`, and `orchestrator` nodes do not.

Before this fix, the scaffolder emitted `SubagentStop` entries for any gate
with an `after:` target, including human checkpoints. Those hooks silently
never fired because no subagent ever ran by that name.

Now the scaffolder:

- Emits a `SubagentStop` hook only when `gate.after` resolves to an agent or
  group node.
- Warns to stderr when a blocking gate targets a non-agent node, explaining
  that the gate wrapper script must be invoked from an orchestrator playbook
  or slash command.
- Still generates the wrapper script for non-agent-targeted gates (with a
  header comment documenting the limitation), so the orchestrator can call it
  directly.
- The gate wrapper script's header now accurately describes whether the gate
  is enforced by a hook (agent target) or must be invoked by the orchestrator
  (non-agent target).

`V25` is rewritten: the rule now fires only for `on-fail: bounce-back` gates
with non-agent (or missing) `after` targets. Gates with agent/group targets
are not flagged because they ARE enforced by the SubagentStop hook on
claude-code (exit 2 prevents the subagent from stopping).

## [0.2.2] — 2026-04-21

### [feat] Observability hook shortcut — SubagentStop in global `hooks {}` block

Global hooks with `on: SubagentStop` now use the declared `run:` path verbatim when it
starts with `.` or `/`, instead of being rewritten into `.claude/skills/<name>/scripts/`.
This enables clean per-agent finish logging without fake gates:

```at
hooks {
  hook log-subagent-finish {
    on: SubagentStop
    matcher: "amitai-cos|nadav-cos|ops-agent"
    run: ".claude/scripts/log-subagent.sh"
    type: command
    timeout: 5000
  }
}
```

The `matcher` and `timeout` are preserved verbatim in the generated `settings.json`.

### [feat] `agentopology info` warns about observability gaps

If a topology has one or more agents but no `SubagentStop`/`Stop` hook (and no
enforced gates, which compile to `SubagentStop`), `agentopology info` now emits a
`[warning]` suggestion with the agent count and a ready-to-paste `hooks {}` snippet.

### [feat] Non-destructive scaffold — `deepMergeSettingsJson`

New `deepMergeSettingsJson` function in the scaffold merge layer handles
`.claude/settings.json` with domain-aware logic:

- `permissions.allow`: union-merged (existing entries survive re-scaffold)
- `permissions.deny`: union-merged (existing entries survive re-scaffold)
- `env`: shallow-merged (generated wins on key conflict, user-only keys preserved)
- `hooks`: rewritten entirely from topology (topology owns hooks)
- All other top-level keys (e.g. `model`, `theme`): existing value wins

Re-scaffold without `--force` calls `deepMergeSettingsJson` for `settings.json`
via the `shared-config` incremental category (already in place). Invalid existing
JSON now throws a descriptive error instead of silently reverting to the existing
file.

### [feat] Agent-scoped env var injection in hook stubs (Change 4)

Generated hook stub scripts now extract `AGENT_TYPE` and `SESSION_ID` from the
Claude Code stdin JSON payload (`agent_type` and `session_id` fields), making the
variables available to the user's implementation:

```bash
PAYLOAD=$(cat)
AGENT_TYPE=$(echo "$PAYLOAD" | jq -r '.agent_type // "unknown"')
SESSION_ID=$(echo "$PAYLOAD" | jq -r '.session_id // ""')
```

### [feat] Hook stub generation for observability scripts (Change 5)

When `scaffold` generates a hook pointing at a path that starts with `.` or `/`
(i.e. an observability-style script, not a skills-directory script), it emits an
executable stub at that exact path. The stub:

- Has a `#!/usr/bin/env bash` shebang
- Contains an auto-generated header (hook name, event, matcher, date)
- Extracts `AGENT_TYPE` from stdin (Change 4 integration)
- Appends a structured JSON line to `.claude/memory/metrics.jsonl`
- Is flagged `executable: true` in the `GeneratedFile` so `executeActions` writes
  it with `chmod 0755`

### [fix] Multi-line suggestions rendered correctly in `agentopology info`

Suggestion messages with embedded newlines (e.g. the observability gap snippet)
are now printed with proper indentation — continuation lines are prefixed with
four spaces.

### Breaking: none

All existing `.at` files validate and scaffold identically. The path-rewriting
change for global hooks only activates when `hook.run` begins with `.` or `/`
(a pattern that was previously broken anyway — it would generate scripts in the
wrong directory).

---

## [0.2.1] — 2026-04

- 10 claude-code binding syntax fixes validated by battle test topology

## [0.2.0] — 2026-04

- OpenClaw importer added
- Gates compile to SubagentStop hooks (not PreToolUse/Task)

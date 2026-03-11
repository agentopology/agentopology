# AgentTopology Reserved Keywords

Created by Nadav Naveh

Reserved keywords are names that **cannot** be used as agent, action, or gate identifiers.

---

## Block Keywords

These introduce grammar constructs:

```
topology, library, import, from, use,
agent, action, orchestrator, meta, roles, memory, flow, gates, gate,
depth, batch, environments, triggers, command, event, level,
hooks, hook, settings, mcp-servers, metering, tools, tool, scale, skill,
context, env, extensions
```

---

## Field Keywords

These are used as field names or enum values:

```
model, tools, disallowed-tools, reads, writes, outputs, skip, retry, isolation,
phase, kind, role, version, description, permissions, prompt,
generates, handles, argument, factors, behavior, invocation, omit,
when, max, parallel, per, manual, advisory, blocking,
min, batch-size, batch-count, doc-count, token-volume, source-count, fixed, config,
track, tokens-in, tokens-out, cost, wall-time, agent-count, format, pricing,
anthropic-current, custom, none, json, jsonl, csv,
pass, fail, plan-gap, bounce-back, halt,
inherit,
autonomous, supervised, interactive, unrestricted,
worktree, append-only, background, skills,
user, project, local, on, matcher, timeout,
AgentStart, AgentStop, ToolUse, Error, SessionStart, SessionEnd,
PreToolUse, PostToolUse, PostToolUseFailure,
SubagentStart, SubagentStop, Stop, UserPromptSubmit,
InstructionsLoaded, PermissionRequest, Notification,
TeammateIdle, TaskCompleted, ConfigChange,
PreCompact, WorktreeCreate, WorktreeRemove,
command, prompt,
allow, deny, ask, http, stdio, sse, args, env, url, script, lang, bash, python, node,
on-fail, after, before, run, checks, load-when,
path, mode, files, routing, protocol, structure, blueprints,
domains, references, external-docs, metrics, workspace, conflicts,
detect, resolve, sequential-rebase, source, commands,
external, git, decision, inline, report, not, ticket, true, false,
max-turns, description, disable-model-invocation, user-invocable, allowed-tools,
domain, fork,
pipeline, supervisor, blackboard, orchestrator-worker, debate,
market-routing, consensus, fan-out, event-driven, human-gate
```

---

## Not Reserved

These are free-form values and can be used as names:

```
branch, render, supabase, target-branch
```

Environment block field names, custom role names, and user-defined enum values are not reserved.

---

## Roadmap Reserved

Reserved for future use, not yet in grammar:

```
event
```

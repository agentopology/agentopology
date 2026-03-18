# Creating AgenTopology Bindings

Created by Nadav Naveh

A binding is a code module that reads a parsed `.at` topology and generates platform-specific output. The `.at` spec defines WHAT to generate. Bindings define HOW for each platform.

---

## The BindingTarget Interface

Every binding implements the `BindingTarget` interface:

```typescript
interface BindingTarget {
  /** Unique identifier for this binding (e.g., "claude-code", "agent-sdk") */
  name: string;

  /** Generate all platform-specific files from a parsed topology */
  scaffold(topology: ParsedTopology, outputDir: string): GeneratedFiles;

  /** Map an abstract model identifier to a platform-specific model string */
  resolveModel(modelId: string): string;

  /** Map a universal permission to a platform-specific permission mode */
  resolvePermission(permission: string): string;

  /** Map a universal hook event to platform-specific event name(s) */
  resolveHookEvent(event: string): string | string[];

  /** Validate that the topology is compatible with this platform */
  validate(topology: ParsedTopology): ValidationError[];
}
```

---

## What scaffold() Should Generate

The `scaffold()` method produces all the files a platform needs to run the topology. At minimum, a binding generates:

1. **Agent definitions** -- one file per agent with model, tools, permissions, and instructions
2. **Orchestrator logic** -- the flow graph translated to the platform's execution model
3. **Permission configuration** -- the `settings` block mapped to the platform's permission system
4. **MCP server configuration** -- the `mcp-servers` block mapped to the platform's integration format
5. **Hook configuration** -- the `hooks` block mapped to the platform's event system

The `scaffold()` method returns a `GeneratedFiles` object:

```typescript
interface GeneratedFiles {
  files: Array<{
    path: string;        // relative to outputDir
    content: string;     // file contents
    overwrite: boolean;  // whether to replace existing files
  }>;
}
```

---

## Mapping Blocks to Platform Files

Here is how each `.at` block type maps to platform output. A binding must handle all of these:

### Agents

Each `agent` block produces one agent definition file. The binding maps:

| `.at` field | What to generate |
|-------------|-----------------|
| `model` | Platform's model selection field |
| `tools` | Tool allowlist in platform format |
| `disallowed-tools` | Tool denylist in platform format |
| `permissions` | Platform's permission mode |
| `prompt` | Body content of the agent file |
| `isolation` | Platform's isolation mechanism |
| `memory` | Platform's persistent memory config |
| `skills` | Platform's skill/plugin loading |
| `mcp-servers` | Platform's MCP server access |
| `background` | Platform's background execution |
| `hooks` | Per-agent hooks in platform format |

### Flow

The `flow` block defines the execution graph. Bindings translate this into:
- Sequential execution logic
- Conditional branching based on outputs
- Fan-out parallel execution
- Loop handling with max bounds

### Gates

Gates are injected between flow nodes. The binding generates:
- Script execution at the gate point
- Retry logic
- Failure handling (halt or bounce-back)

### Settings

The `settings` block maps to the platform's global permission configuration:
- `allow` -> tools that run without confirmation
- `deny` -> tools that are blocked
- `ask` -> tools that require confirmation

### MCP Servers

The `mcp-servers` block produces the platform's MCP configuration file. Each server entry maps to a server definition with type, command/url, args, and env.

### Hooks

The `hooks` block maps to the platform's event system. The binding must:
1. Map universal events (`AgentStart`, `AgentStop`, `ToolUse`, etc.) to platform events
2. Handle platform-specific events if accepted
3. Generate hook configuration in the platform's format

---

## Model Resolution

Bindings map model identifiers to platform-specific strings. The `.at` spec allows any identifier matching `[a-z][a-z0-9-/.]*` as a model.

A binding should:
1. Recognize its own model aliases (e.g., a Claude binding knows `opus`, `sonnet`, `haiku`)
2. Pass through unknown identifiers (e.g., `gpt-4o` passes through in an OpenAI binding)
3. Map `inherit` to the orchestrator's model

Example model resolution:

```typescript
function resolveModel(modelId: string): string {
  const aliases: Record<string, string> = {
    "opus": "claude-opus-4-20250514",
    "sonnet": "claude-sonnet-4-20250514",
    "haiku": "claude-haiku-3-5-20241022",
  };
  return aliases[modelId] || modelId;
}
```

---

## Permission Resolution

The spec defines four universal permission levels. Bindings map these to platform-specific modes:

| Universal | Meaning |
|-----------|---------|
| `autonomous` | Read and write without confirmation |
| `supervised` | Read freely, propose writes for approval |
| `interactive` | Confirm all actions |
| `unrestricted` | No permission checks |

Example:

```typescript
function resolvePermission(permission: string): string {
  const mapping: Record<string, string> = {
    "autonomous": "auto",
    "supervised": "plan",
    "interactive": "confirm",
    "unrestricted": "bypass",
    // Accept short aliases too
    "auto": "auto",
    "plan": "plan",
    "confirm": "confirm",
    "bypass": "bypass",
  };
  return mapping[permission] || permission;
}
```

---

## Hook Event Resolution

Universal events must be mapped to platform-specific event names:

| Universal | Example platform mapping |
|-----------|------------------------|
| `AgentStart` | `SubagentStart` (Claude Code) |
| `AgentStop` | `SubagentStop` (Claude Code) |
| `ToolUse` | `PreToolUse`, `PostToolUse` (Claude Code) |
| `Error` | `PostToolUseFailure` (Claude Code) |
| `SessionStart` | `SessionStart` (Claude Code) |
| `SessionEnd` | `Stop` (Claude Code) |

Note that `ToolUse` may map to multiple platform events. The binding decides whether to register for pre-use, post-use, or both.

---

## Example: Mapping an Agent Block

Given this `.at` agent:

```agenttopology
agent writer {
  role: writer
  model: sonnet
  permissions: autonomous
  prompt: "prompts/writer.md"
  phase: 2
  tools: [Read, Write, Glob]
  reads: ["workspace/research.md"]
  writes: ["workspace/draft.md"]
  outputs: {
    confidence: high | medium | low
  }
}
```

A Claude Code binding would generate `.claude/agents/writer/AGENT.md`:

```markdown
---
model: claude-sonnet-4-20250514
permissionMode: auto
tools:
  - Read
  - Write
  - Glob
description: "Draft content based on research findings"
---

[contents of prompts/writer.md]
```

An Agent SDK binding would generate `agents/writer.json`:

```json
{
  "name": "writer",
  "model": "claude-sonnet-4-20250514",
  "tools": ["Read", "Write", "Glob"],
  "instructions_file": "prompts/writer.md",
  "outputs": {
    "confidence": ["high", "medium", "low"]
  }
}
```

---

## Existing Bindings

| Binding | Status | Target | Description |
|---------|--------|--------|-------------|
| `claude-code` | **Stable** | Claude Code | Generates `.claude/agents/`, `.claude/settings.json`, `.mcp.json` |
| `agent-sdk` | Planned | Anthropic Agent SDK | Tool definitions and agent configs for the Agent SDK |
| `e2b` | Planned | E2B | Sandbox configuration and tool registration |
| `openai-swarm` | Planned | OpenAI Swarm | Swarm agent definitions and handoff logic |

---

## Testing a Binding

To verify your binding works correctly:

1. **Round-trip test** -- scaffold a topology, then verify the generated files parse correctly on the target platform
2. **Validation test** -- ensure `validate()` catches incompatibilities (e.g., platform doesn't support `isolation: worktree`)
3. **Model resolution test** -- verify all common model identifiers resolve correctly
4. **Permission resolution test** -- verify all four universal permissions map to valid platform modes
5. **Hook event test** -- verify all six universal events map to platform events

```bash
agentopology scaffold examples/simple-pipeline.at --target your-binding --dry-run
```

The `--dry-run` flag prints generated files without writing them, useful for testing.

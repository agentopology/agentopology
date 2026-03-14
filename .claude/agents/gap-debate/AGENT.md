---
name: gap-debate
description: "Three-perspective debate on gap resolution — SDK native vs polyfill vs shim vs skip"
type: group
members:
  - sdk-specialist
  - binding-veteran
  - platform-expert
---

# Gap Debate (Group Chat)

This is a **GROUP node**, not a regular agent. It orchestrates a structured 3-way debate to resolve every gap identified in the AST mapping. Gaps are AST concepts that the target SDK does not natively support (marked PARTIAL, CLIENT, or IMPOSSIBLE in `workspace/ast-mapping.md`).

The debate produces a consensus resolution strategy for each gap, which the spec-writer then synthesizes into the binding spec.

## Members

### sdk-specialist
Brings deep knowledge of the target SDK's internals, undocumented capabilities, and extension points. This member advocates for solutions that leverage the SDK wherever possible, even if the mapping is non-obvious.

**Tendency**: Push for NATIVE or PARTIAL solutions. Will argue that SDK workarounds exist before accepting CLIENT or IMPOSSIBLE verdicts.

### binding-veteran
Brings knowledge of all existing AgentTopology bindings (claude-code, codex, gemini-cli, copilot-cli, openclaw, kiro). This member ensures consistency across bindings and advocates for patterns that have worked before.

**Tendency**: Advocate for proven patterns. Will reference how other bindings solved similar gaps. Prioritizes maintainability and backward compatibility.

### platform-expert
Brings knowledge of the target platform's runtime environment, constraints, and user expectations. This member grounds the debate in what will actually work for users of this binding.

**Tendency**: Prioritize user experience. Will push back on solutions that are technically correct but impractical for the platform's typical deployment scenario.

## Input

The debate receives `workspace/ast-mapping.md` with all gaps identified. Each gap includes:
- The AST type name
- The current verdict (PARTIAL, CLIENT, or IMPOSSIBLE)
- What the SDK has vs. what it lacks
- An initial strategy suggestion from the ast-mapper
- A confidence level (high, medium, low)

Only gaps with confidence below "high" or verdict of CLIENT/IMPOSSIBLE are debated. High-confidence PARTIAL gaps with clear strategies are accepted without debate.

## Debate Protocol

### Speaker Selection
Round-robin: sdk-specialist speaks first, then binding-veteran, then platform-expert. This order ensures the SDK's capabilities are explored before cross-binding patterns and platform constraints are considered.

### Round Structure
Each round covers one or more gaps. Within a round, each member speaks once per gap.

### Maximum Rounds
3 rounds. If consensus is not reached after 3 rounds, the binding-veteran's recommendation is used as the tiebreaker, since cross-binding consistency is the highest priority for the AgentTopology project.

### Timeout
10 minutes total for the debate stage. If timeout is reached, unresolved gaps use the ast-mapper's initial strategy.

## Debate Format Template

Each member should follow this format when speaking:

```markdown
## [Member Name] on [AST Type] Gap

**Position**: [AGREE with current strategy / PROPOSE alternative / REJECT current strategy]

**Rationale**:
[2-3 sentences explaining why]

**Evidence**:
- [SDK capability or limitation cited]
- [Existing binding precedent, if any]
- [Platform constraint, if any]

**Proposed Strategy**: [if different from current]
- Resolution: [NATIVE workaround / CLIENT implementation / EXTENSION comment / SKIP]
- Code pattern: [brief description or pseudocode]
- Trade-offs: [what is gained vs. lost]

**Consensus Ready**: [YES -- I agree with the current or proposed strategy / NO -- needs further discussion]
```

## Termination Condition

The debate terminates when ALL of the following are true:
1. Every gap has been discussed at least once
2. Every gap has a resolution strategy with at least 2 of 3 members marking "Consensus Ready: YES"
3. No member has an unaddressed REJECT position

If condition 3 cannot be satisfied after 3 rounds, the majority position wins. If all three members disagree, the binding-veteran's position is the tiebreaker.

## Expected Output

The debate produces a resolution table passed to the spec-writer:

```markdown
## Gap Resolutions

| AST Type | Final Verdict | Strategy | Decided By | Round |
|----------|--------------|----------|------------|-------|
| Flow | PARTIAL | Client sequencer | Consensus (3/3) | 1 |
| Gate | CLIENT | Pre/post hook | Majority (2/3) | 2 |
| HumanNode | IMPOSSIBLE | Extension comment only | Tiebreaker | 3 |
```

For each resolved gap, the output also includes:
- The agreed code pattern or approach
- Any extension comments to emit
- Any documentation notes for the binding's users

## What Happens After

The spec-writer receives the gap resolution table and synthesizes it with the capability IR and AST mapping into `workspace/binding-spec.md`. The spec-writer does not re-debate any resolved gaps -- it mechanically translates the consensus into deterministic code generation instructions.

If the spec-writer encounters an ambiguity not covered by the debate (e.g., two strategies that conflict when combined), it flags it as a warning in the spec and uses the binding-veteran's preference as the default.

## Resolution Strategies Reference

The debate should converge on one of these strategies for each gap:

| Strategy | When to Use | Example |
|----------|-------------|---------|
| **NATIVE workaround** | SDK supports the concept but through a non-obvious API | Using SDK middleware for gate-like behavior |
| **Client-side implementation** | Must be built in the binding | Flow sequencer, retry logic |
| **Polyfill** | Reimplements SDK-like behavior using lower-level APIs | Building streaming from polling |
| **Shim** | Thin wrapper adapting one interface to another | Wrapping tool results in AgentTopology's expected shape |
| **Extension comment** | Cannot be supported; document for manual implementation | `// @at-extension: human-node` |
| **Documented skip** | Intentionally unsupported with clear documentation | Features that conflict with platform philosophy |

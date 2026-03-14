---
name: binding-review
description: "Human reviews the generated binding source before running the full test suite"
---

# Binding Review (Human-in-the-Loop)

Human reviews the generated binding source before running the full test suite.

## What to Review

When the code-generator completes and the type-and-coverage gate passes, the pipeline
pauses here for human review. Check:

1. **Does the binding file look reasonable?** Read `src/bindings/<name>.ts` — does it
   follow the same structure as `claude-code.ts`?
2. **Is it registered?** Check `src/bindings/index.ts` for the import and registry entry.
3. **Do the model mappings make sense?** The binding maps topology aliases (opus, sonnet,
   haiku) to SDK-specific model IDs — are they correct?
4. **Are the gap strategies acceptable?** Check the binding-spec for any SKIPped features
   that you expected to be supported.

## Approval

- **Approve**: Pipeline continues to conformance-checker
- **Reject**: Pipeline halts (you can manually re-launch code-generator with feedback)

## Timeout

If no response within 1 hour, the pipeline continues automatically (on-timeout: skip).


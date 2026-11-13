/** S-01: what V96 and the bindings read from a `run:` that names its script through $CLAUDE_PROJECT_DIR. */
import { describe, it, expect } from "vitest";
import { proseInRun, runParts, scriptNameFromRun } from "../run.js";

describe("a quoted project-dir variable path is a path", () => {
  it.each([
    ['"$CLAUDE_PROJECT_DIR"/.claude/hooks/x.sh', "./.claude/hooks/x.sh", undefined],
    ['"${CLAUDE_PROJECT_DIR}/.claude/hooks/x.sh"', "./.claude/hooks/x.sh", undefined],
    ['$CLAUDE_PROJECT_DIR/.claude/hooks/x.sh', "./.claude/hooks/x.sh", undefined],
    ['bash "$CLAUDE_PROJECT_DIR/.claude/hooks/x.sh"', "./.claude/hooks/x.sh", "bash"],
    ['/bin/sh "${CLAUDE_PROJECT_DIR:-.}/scripts/x.sh"', "./scripts/x.sh", "/bin/sh"],
  ])("%s", (run, script, interpreter) => {
    expect(runParts(run)).toMatchObject({ script, ...(interpreter ? { interpreter } : {}) });
    expect(scriptNameFromRun(run)).toBe("x.sh");
    expect(proseInRun(run)).toBeNull();
  });

  it("still refuses prose and other quoted first words", () => {
    expect(proseInRun("Check: the build passes")).not.toBeNull();
    expect(proseInRun('"run the linter" then report')).not.toBeNull();
    expect(proseInRun('"$HOME"/x.sh')).not.toBeNull();
  });
});

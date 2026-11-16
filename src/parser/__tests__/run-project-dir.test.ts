/**
 * S-01: import reads a command that names its script through $CLAUDE_PROJECT_DIR
 * as that path, to name the hook (src/import/run-words.ts). What a binding
 * compiles such a `run:` to is 0.11.2's resolution in 0.11.3 (V96 refuses the
 * quoted forms, as 0.11.2 did); reading them as paths there is 0.12, with S-11.
 */
import { describe, it, expect } from "vitest";
import { proseInRun } from "../run.js";
import { commandParts } from "../../import/run-words.js";

describe("import reads a quoted project-dir variable path as a path", () => {
  it.each([
    ['"$CLAUDE_PROJECT_DIR"/.claude/hooks/x.sh', "./.claude/hooks/x.sh", undefined],
    ['"${CLAUDE_PROJECT_DIR}/.claude/hooks/x.sh"', "./.claude/hooks/x.sh", undefined],
    ['$CLAUDE_PROJECT_DIR/.claude/hooks/x.sh', "./.claude/hooks/x.sh", undefined],
    ['bash "$CLAUDE_PROJECT_DIR/.claude/hooks/x.sh"', "./.claude/hooks/x.sh", "bash"],
    ['/bin/sh "${CLAUDE_PROJECT_DIR:-.}/scripts/x.sh"', "./scripts/x.sh", "/bin/sh"],
  ])("%s", (run, script, interpreter) => {
    expect(commandParts(run)).toMatchObject({ script, ...(interpreter ? { interpreter } : {}) });
  });

  it("validate still refuses prose and other quoted first words", () => {
    expect(proseInRun("Check: the build passes")).not.toBeNull();
    expect(proseInRun('"run the linter" then report')).not.toBeNull();
    expect(proseInRun('"$HOME"/x.sh')).not.toBeNull();
  });
});

/**
 * S-23..S-27: five false positives the scan found on public harnesses.
 * Spec: docs/plans/s23-fp-batch.md. Synthetic fixtures only.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "../../parser/index.js";
import { unanchoredScript as ccUnanchored, checkHooks as ccCheckHooks } from "../../conformance/claude-code.js";
import { unanchoredScript as cxUnanchored } from "../../conformance/codex.js";
import { checkConfigAgainstSchema } from "../../conformance/surface.js";
import { codexBinding } from "../../bindings/codex.js";
import { collectInventory, coverage } from "../../inventory/index.js";
import { checkGuards } from "../../guard/check.js";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../../..");
const schema = JSON.parse(fs.readFileSync(join(repo, "spec/codex/config.schema.json"), "utf8"));

const dirs: string[] = [];
function tmp(): string {
  const d = fs.mkdtempSync(join(os.tmpdir(), "at-s23-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("[S-23] cc.hooks.cwd: the project-dir variable with a default is anchored", () => {
  it("[S-23] ${CLAUDE_PROJECT_DIR:-.}/x.sh, quoted or not, is anchored", () => {
    expect(ccUnanchored('/bin/sh "${CLAUDE_PROJECT_DIR:-.}/scripts/tooling/dispatch.sh"')).toBeNull();
    expect(ccUnanchored("${CLAUDE_PROJECT_DIR:-.}/scripts/x.sh")).toBeNull();
    expect(ccUnanchored('"${CLAUDE_PROJECT_DIR:-.}"/scripts/x.sh')).toBeNull();
    expect(ccUnanchored('bash "${CLAUDE_PROJECT_DIR:-$PWD}/hooks/x.sh" --flag')).toBeNull();
    const hooks = { PreToolUse: [{ hooks: [{ type: "command", command: '/bin/sh "${CLAUDE_PROJECT_DIR:-.}/scripts/x.sh"' }] }] };
    expect(ccCheckHooks(hooks).filter((v) => v.rule === "cwd")).toEqual([]);
  });

  it("[S-23] the forms that were anchored stay anchored; a relative path still fails", () => {
    expect(ccUnanchored('"$CLAUDE_PROJECT_DIR"/.claude/hooks/x.sh')).toBeNull();
    expect(ccUnanchored("${CLAUDE_PROJECT_DIR}/x.sh")).toBeNull();
    expect(ccUnanchored("/opt/x.sh")).toBeNull();
    expect(ccUnanchored(".claude/hooks/x.sh")).toBe(".claude/hooks/x.sh");
    expect(ccUnanchored("bash scripts/x.sh")).toBe("scripts/x.sh");
    // a look-alike variable is not the project dir
    expect(ccUnanchored("${CLAUDE_PROJECT_DIRX:-.}/x.sh")).not.toBeNull();
  });
});


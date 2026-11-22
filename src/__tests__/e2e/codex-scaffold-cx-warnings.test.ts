/**
 * `scaffold --target codex` and `guard --target codex` report the Codex rows
 * (CX*) as warnings and write the files, as 0.12.4 did. Passing the target to
 * validate() so V135 is judged per target also brought in the CX rows, and
 * the error-level ones (CX8-event, CX8-tool, CX8-regex) began to stop both
 * commands. `validate --target codex` keeps reporting CX8 as an error (exit
 * 1), as 0.12.4 did, and V135 stays scoped: not on cursor, an error on
 * claude-code and codex.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const CLI = resolve(here, "../../../dist/cli/index.js");

/** stdout and stderr both: the binding prints its Codex warnings on stderr. */
const run = (args: string[], cwd: string) => {
  const r = spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", cwd });
  return { out: `${r.stdout ?? ""}${r.stderr ?? ""}`, code: r.status ?? 1 };
};

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(join(tmpdir(), "at-cx-warn-")); });
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));
const put = (name: string, text: string) => { fs.writeFileSync(join(dir, name), text); return join(dir, name); };

/** Two agents and a refusing hook on Stop, which Codex cannot block (CX8-event). */
const STOP_REFUSE = `topology t : [pipeline] {
  meta {
    version: "1.0.0"
    description: "codex scaffold probe"
  }
  orchestrator {
    model: gpt-5.2
  }
  agent a {
    model: gpt-5.2
    description: "a"
  }
  agent b {
    model: gpt-5.2
    description: "b"
  }
  flow { a -> b }
  hooks {
    hook stopper {
      on: Stop
      run: "scripts/check.sh"
      type: command
      strength: refuse
    }
  }
}
`;

const CX8_TEXT = `hook "stopper" declares strength: refuse on Stop, which cannot block a call on Codex`;

/** A refusing gate before a report step that no generated hook runs (V135 on claude-code and codex). */
const hooklessGate = (model: string) => `topology t : [pipeline] {
  meta {
    version: "1.0.0"
    description: "a refusing gate that no hook runs"
  }
  orchestrator {
    model: ${model}
    handles: [intake, finish]
  }
  action intake {
    kind: inline
    description: "Take the request"
  }
  agent writer {
    model: ${model}
    description: "Writes the report"
    prompt {
      Write the report.
    }
  }
  action finish {
    kind: report
    description: "Hand the result back to the user"
  }
  flow {
    intake -> writer
    writer -> finish
  }
  gates {
    gate numbers-need-a-source {
      before: finish
      description: "A number in a report must match a command's output"
      run: "bash tools/numbers-need-a-source.sh"
      strength: refuse
      on-fail: halt
    }
  }
}
`;

describe("Codex rows warn on scaffold and guard --target codex, as in 0.12.4", () => {
  it("scaffold --target codex --dry-run exits 0 and shows CX8-event as a warning", () => {
    put("t.at", STOP_REFUSE);
    const r = run(["scaffold", "t.at", "--target", "codex", "--dry-run"], dir);
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain(CX8_TEXT);
    expect(r.out).not.toContain("validation error(s)");
    expect(r.out).toContain("+ .codex/hooks.json");
  });

  it("scaffold --target codex writes the files", () => {
    put("t.at", STOP_REFUSE);
    const r = run(["scaffold", "t.at", "--target", "codex"], dir);
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain(CX8_TEXT);
    expect(fs.existsSync(join(dir, ".codex/hooks.json"))).toBe(true);
  });

  it("guard --target codex --dry-run exits 0 and shows CX8-event as a warning", () => {
    const file = put("t.at", STOP_REFUSE);
    const r = run(["guard", file, "--target", "codex", "--dir", dir, "--dry-run"], dir);
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain(CX8_TEXT);
    expect(r.out).not.toContain("Nothing was written");
    expect(r.out).toContain("+ .codex/hooks.json");
  });

  it("validate --target codex still reports CX8-event as an error and exits 1, as 0.12.4 did", () => {
    put("t.at", STOP_REFUSE);
    const r = run(["validate", "t.at", "--target", "codex"], dir);
    expect(r.code, r.out).toBe(1);
    expect(r.out).toContain("ERROR [CX8-event]");
  });
});

describe("V135 stays scoped by target", () => {
  it("scaffold --target cursor is not stopped by it", () => {
    put("t.at", hooklessGate("sonnet"));
    const r = run(["scaffold", "t.at", "--target", "cursor", "--dry-run"], dir);
    expect(r.out).not.toContain("[V135]");
    expect(r.code, r.out).toBe(0);
  });

  it("scaffold --target claude-code is stopped by it", () => {
    put("t.at", hooklessGate("sonnet"));
    const r = run(["scaffold", "t.at", "--target", "claude-code", "--dry-run"], dir);
    expect(r.out).toContain("[V135]");
    expect(r.code).toBe(1);
  });

  it("scaffold and guard --target codex are stopped by it", () => {
    const file = put("t.at", hooklessGate("gpt-5.2"));
    const s = run(["scaffold", "t.at", "--target", "codex", "--dry-run"], dir);
    expect(s.out).toContain("[V135]");
    expect(s.code).toBe(1);
    const g = run(["guard", file, "--target", "codex", "--dir", dir, "--dry-run"], dir);
    expect(g.out).toContain("[V135]");
    expect(g.code).toBe(1);
  });
});

/**
 * 0.13.0: a guard script scaffold keeps instead of regenerating is never silent.
 *
 * A before-action.sh (or before-edit.sh) at its generated path that scaffold did not write (a
 * hand-built harness), or one edited since it wrote it, is kept, --force included, so the guards
 * this version writes never land there. scaffold prints a line naming it, and guard --check grades
 * the gates that script should hold as none, with the same reason. The manifest decides whose the
 * file is, as scaffold does: no entry for it, or a hash that no longer matches the disk.
 *
 * Runs the built CLI (dist/), as guard-check.test.ts does.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const CLI = resolve(here, "../../../dist/cli/index.js");
const VERSION = JSON.parse(fs.readFileSync(resolve(here, "../../../package.json"), "utf8")).version as string;

const SRC = `topology ship : [pipeline] {
  meta {
    version: "1.0.0"
    description: "Render, then publish and open the source"
  }
  orchestrator {
    model: opus
    handles: [render, publish, editor]
  }
  action render {
    kind: external
    commands: ["./tool render"]
  }
  action publish {
    kind: external
    commands: ["./tool publish"]
  }
  agent editor {
    model: sonnet
    description: "Edits the source"
  }
  records {
    record trace { path: "logs/trace.jsonl" }
  }
  gates {
    gate publish-ready {
      after: render
      before: publish
      ledger: trace
      on-fail: halt
    }
    gate src-open {
      after: render
      before: write "src/**"
      ledger: trace
      on-fail: halt
    }
  }
  flow {
    render -> publish
    render -> editor
  }
}
`;

const SCRIPTS = ".claude/skills/ship/scripts";
const ACTION = `${SCRIPTS}/before-action.sh`;
const EDIT = `${SCRIPTS}/before-edit.sh`;
let root: string;
const at = (p: string) => join(root, p);
const cli = (...args: string[]) => spawnSync(process.execPath, [CLI, ...args], { cwd: root, encoding: "utf8" });
const keptLine = (p: string) => `kept your ${p}: the new ${VERSION} guards are NOT in it`;
const HAND = "#!/usr/bin/env bash\n# my own guard\nexit 0\n";

beforeEach(() => {
  root = fs.mkdtempSync(join(os.tmpdir(), "at-kept-guard-"));
  fs.writeFileSync(at("ship.at"), SRC);
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

function plant(p: string, text = HAND) {
  fs.mkdirSync(dirname(at(p)), { recursive: true });
  fs.writeFileSync(at(p), text);
}
const grade = (out: string, id: string) => out.split("\n").find((l) => l.includes(id) && /\b(refuse|none|hope|cited)\b/.test(l)) ?? "";

describe("[kept guard] scaffold and guard --check say a kept guard script", () => {
  it("a scaffold that writes the guards prints no kept line, and the gates refuse", () => {
    const s = cli("scaffold", "ship.at", "--target", "claude-code");
    expect(s.status, s.stderr).toBe(0);
    expect(s.stdout).not.toContain("kept your");
    const g = cli("guard", "ship.at", "--check", "--dir", ".");
    expect(grade(g.stdout, "publish-ready")).toContain("refuse");
    expect(g.stdout).not.toContain("kept your");
  });

  it("the first scaffold into a hand-built harness names each guard script it kept; guard --check grades their gates none", () => {
    plant(ACTION);
    plant(EDIT);
    const s = cli("scaffold", "ship.at", "--target", "claude-code");
    expect(s.status, s.stderr).toBe(0);
    expect(s.stdout).toContain(keptLine(ACTION));
    expect(s.stdout).toContain(keptLine(EDIT));
    expect(s.stdout).toContain("--force does not replace it");
    expect(fs.readFileSync(at(ACTION), "utf8")).toBe(HAND);
    const g = cli("guard", "ship.at", "--check", "--dir", ".");
    expect(g.status).toBe(1);
    expect(grade(g.stdout, "publish-ready")).toContain("none");
    expect(g.stdout).toContain(keptLine(ACTION));
    expect(g.stdout).toContain(keptLine(EDIT));
  });

  it("a guard script edited after scaffold wrote it: the next scaffold and guard --check say so; --force keeps it too", () => {
    expect(cli("scaffold", "ship.at", "--target", "claude-code").status).toBe(0);
    fs.appendFileSync(at(ACTION), "# a local change\n");
    const s = cli("scaffold", "ship.at", "--target", "claude-code");
    expect(s.stdout).toContain(keptLine(ACTION));
    expect(s.stdout).not.toContain(keptLine(EDIT));
    const f = cli("scaffold", "ship.at", "--target", "claude-code", "--force");
    expect(f.stdout).toContain(keptLine(ACTION));
    expect(fs.readFileSync(at(ACTION), "utf8")).toContain("# a local change");
    const g = cli("guard", "ship.at", "--check", "--dir", ".");
    expect(grade(g.stdout, "publish-ready")).toContain("none");
    expect(g.stdout).toContain(keptLine(ACTION));
    expect(g.stdout).not.toContain(keptLine(EDIT));
  });

  it("deleted and scaffolded again: generated, and the gates refuse", () => {
    plant(ACTION);
    expect(cli("scaffold", "ship.at", "--target", "claude-code").status).toBe(0);
    fs.unlinkSync(at(ACTION));
    const s = cli("scaffold", "ship.at", "--target", "claude-code");
    expect(s.stdout).not.toContain("kept your");
    const g = cli("guard", "ship.at", "--check", "--dir", ".");
    expect(grade(g.stdout, "publish-ready")).toContain("refuse");
  });
});

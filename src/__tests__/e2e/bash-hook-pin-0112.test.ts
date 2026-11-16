/**
 * Pin: `bash <script>` / `sh <script>` hooks whose script is under .claude/hooks
 * import clean and scaffold to the exact command 0.11.2 wrote, and the hook runs
 * the user's own script (exit 2 blocks).
 *
 * Measured on npm 0.11.2 and 0.11.3 (16 Nov): both import these with exit 0 and
 * scaffold `bash .claude/hooks/x.sh` / `sh .claude/hooks/x.sh` unchanged. Only a
 * script OUTSIDE .claude/hooks (`bash scripts/x.sh`) is flagged, because 0.11.2
 * scaffolded it to a stub that exits 1 (a guard silently gone).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const CLI = resolve(here, "../../../dist/cli/index.js");
const SCRIPT = '#!/bin/sh\necho "pin guard refuses" >&2\nexit 2\n';
const FLAG = "can't be compiled faithfully";

describe("bash/sh <script> under .claude/hooks: 0.11.2's command, the user's script runs", () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(join(os.tmpdir(), "at-bashpin-"));
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  const cli = (args: string[]) => spawnSync(process.execPath, [CLI, ...args], { cwd: root, encoding: "utf8", timeout: 60_000 });

  /** A harness with one PreToolUse hook; import it, scaffold the .at over a copy of the harness. */
  const roundTrip = (command: string, scriptRel: string) => {
    const harness = join(root, "harness");
    fs.mkdirSync(join(harness, dirname(scriptRel)), { recursive: true });
    fs.writeFileSync(join(harness, scriptRel), SCRIPT, { mode: 0o755 });
    fs.mkdirSync(join(harness, ".claude"), { recursive: true });
    fs.writeFileSync(join(harness, ".claude/settings.json"), JSON.stringify({
      hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command }] }] },
    }, null, 2));
    const out = join(root, "out");
    fs.mkdirSync(out);
    const imp = cli(["import", "--target", "claude-code", "--dir", harness, "--name", "pin", "--output", out]);
    const atPath = join(out, "pin.at");
    const proj = join(root, "proj");
    fs.cpSync(harness, proj, { recursive: true });
    const scaf = cli(["scaffold", atPath, "--target", "claude-code", "--output", proj, "--force"]);
    const settings = JSON.parse(fs.readFileSync(join(proj, ".claude/settings.json"), "utf8"));
    const commands = (settings.hooks.PreToolUse as Array<{ hooks: Array<{ command: string }> }>).flatMap((g) => g.hooks.map((h) => h.command));
    return { imp, at: fs.readFileSync(atPath, "utf8"), scaf, commands, proj };
  };

  for (const command of ["bash .claude/hooks/x.sh", "sh .claude/hooks/x.sh"]) {
    it(`[S-80 pin] ${command}: import exit 0, scaffold to 0.11.2's exact command, the hook exits 2`, () => {
      const r = roundTrip(command, ".claude/hooks/x.sh");
      expect(r.imp.status).toBe(0);
      expect(r.imp.stdout + r.imp.stderr).not.toContain(FLAG);
      expect(r.at).not.toContain(FLAG);
      expect(r.at).toContain(`run: ${JSON.stringify(command)}`);
      expect(r.scaf.status).toBe(0);
      // 0.11.2 (npm) wrote exactly this one command for this harness.
      expect(r.commands).toEqual([command]);
      expect(fs.readFileSync(join(r.proj, ".claude/hooks/x.sh"), "utf8")).toBe(SCRIPT);
      const run = spawnSync("sh", ["-c", r.commands[0]], {
        cwd: r.proj, encoding: "utf8", timeout: 20_000, input: '{"tool_name":"Bash"}',
        env: { ...process.env, CLAUDE_PROJECT_DIR: r.proj },
      });
      expect(run.status).toBe(2);
      expect(run.stderr).toContain("pin guard refuses");
    });
  }

  it("[S-80 pin] contrast: bash scripts/x.sh (outside .claude/hooks) is flagged, import exit 2", () => {
    const r = roundTrip("bash scripts/x.sh", "scripts/x.sh");
    expect(r.imp.status).toBe(2);
    expect(r.imp.stdout + r.imp.stderr).toContain(FLAG);
  });
});

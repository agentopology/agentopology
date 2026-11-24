/**
 * A refuse hook on PermissionRequest denies through the decision object.
 *
 * Claude Code does not read exit 2 as a decision on PermissionRequest
 * (code.claude.com/docs/en/hooks, "PermissionRequest decision control":
 * "Claude Code doesn't read exit code 2 as a decision on this event. To grant
 * or deny the request, return the `decision` object."). Measured on 0.12.6:
 * the hook's command ran the script as written, so a script that refused by
 * exit 2 denied nothing, and the unwritten stub exited 2 (or 1), which
 * denied nothing either.
 */

import { describe, it, expect, afterAll } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import { join, dirname } from "node:path";
import { spawnSync } from "node:child_process";
import { parse } from "../../parser/index.js";
import { bindings } from "../../bindings/index.js";
import { STUB_MARKER } from "../../bindings/lib/stub.js";
import { stubsOf } from "../../scaffold/stubs.js";
import { checkGuards } from "../../guard/check.js";
import { parseSettingsJson } from "../../import/claude-code.js";

const SOURCE = (strength = "refuse", run = "bash tools/perm-guard.sh") => `topology perm : [pipeline] {
  meta {
    version: "0.1.0"
    description: "a refuse hook on PermissionRequest"
  }
  agent builder {
    model: sonnet
    description: "Builds"
    prompt {
      Build.
    }
  }
  agent reviewer {
    model: sonnet
    description: "Reviews"
    prompt {
      Review.
    }
  }
  flow {
    builder -> reviewer [guard: perm-guard]
  }
  gates {
    gate g1 {
      after: builder
      before: reviewer
      description: "Permission checked"
    }
  }
  hooks {
    hook perm-guard {
      on: PermissionRequest
      matcher: "Bash"
      run: "${run}"
      type: command
      strength: ${strength}
    }
  }
}
`;

const scaffold = (src: string) => bindings["claude-code"].scaffold(parse(src));
const settingsOf = (src: string) => JSON.parse(scaffold(src).find((f) => f.path === ".claude/settings.json")!.content);
const commandOf = (src: string): string => settingsOf(src).hooks.PermissionRequest[0].hooks[0].command;

const roots: string[] = [];
afterAll(() => { for (const r of roots) fs.rmSync(r, { recursive: true, force: true }); });

/** Scaffold into a fresh folder, optionally replacing the hook script, and run the hook command there. */
function run(src: string, script?: string) {
  const root = fs.mkdtempSync(join(os.tmpdir(), "at-permreq-"));
  roots.push(root);
  for (const f of scaffold(src)) {
    fs.mkdirSync(dirname(join(root, f.path)), { recursive: true });
    fs.writeFileSync(join(root, f.path), f.content);
  }
  if (script !== undefined) fs.writeFileSync(join(root, "tools/perm-guard.sh"), script);
  const r = spawnSync("bash", ["-c", commandOf(src)], {
    input: JSON.stringify({ hook_event_name: "PermissionRequest", tool_name: "Bash", tool_input: { command: "rm -rf /" } }),
    env: { ...process.env, CLAUDE_PROJECT_DIR: root },
    encoding: "utf-8",
  });
  return { root, status: r.status, stdout: r.stdout, stderr: r.stderr };
}

const decision = (stdout: string) => JSON.parse(stdout.trim()).hookSpecificOutput;

describe("a refuse hook on PermissionRequest denies by the decision object", () => {
  it("the unwritten stub prints the deny JSON naming the script, and exits 0", () => {
    const f = scaffold(SOURCE()).find((x) => x.path === "tools/perm-guard.sh")!;
    expect(f.content).toContain(STUB_MARKER);
    const r = run(SOURCE());
    expect(r.status).toBe(0);
    const out = decision(r.stdout);
    expect(out.hookEventName).toBe("PermissionRequest");
    expect(out.decision.behavior).toBe("deny");
    expect(out.decision.message).toBe("perm-guard is a stub: it denies every PermissionRequest until you write tools/perm-guard.sh and remove its AGENTOPOLOGY_STUB line.");
  });

  it("the stub is counted as a hook stub", () => {
    expect(stubsOf(scaffold(SOURCE())).stubs).toContainEqual({ kind: "hook", path: "tools/perm-guard.sh" });
  });

  it("a python stub prints the same deny JSON and exits 0", () => {
    const f = scaffold(SOURCE("refuse", "python3 tools/perm-guard.py")).find((x) => x.path === "tools/perm-guard.py")!;
    expect(f.content).toContain(STUB_MARKER);
    const r = spawnSync("python3", ["-c", f.content], { input: "{}", encoding: "utf-8" });
    expect(r.status).toBe(0);
    expect(decision(r.stdout).decision).toEqual({
      behavior: "deny",
      message: "perm-guard is a stub: it denies every PermissionRequest until you write tools/perm-guard.py and remove its AGENTOPOLOGY_STUB line.",
    });
  });

  it("a written script that refuses by exit 2 becomes a deny, exit 0", () => {
    const r = run(SOURCE(), "#!/usr/bin/env bash\necho 'no rm -rf' >&2\nexit 2\n");
    expect(r.status).toBe(0);
    expect(decision(r.stdout).decision.behavior).toBe("deny");
    expect(decision(r.stdout).decision.message).toContain("perm-guard");
  });

  it("a written script that prints its own decision is passed through as is", () => {
    const allow = JSON.stringify({ hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow" } } });
    const r = run(SOURCE(), `#!/usr/bin/env bash\necho '${allow}'\nexit 0\n`);
    expect(r.status).toBe(0);
    expect(decision(r.stdout).decision.behavior).toBe("allow");
  });

  it("a written script that exits 0 silently prints nothing", () => {
    const r = run(SOURCE(), "#!/usr/bin/env bash\nexit 0\n");
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe("");
  });

  it("import reads the generated command back as the hook's run and strength", () => {
    const hook = parseSettingsJson(JSON.stringify(settingsOf(SOURCE()))).hooks.find((h) => h.on === "PermissionRequest")!;
    expect(hook.run).toBe('bash "$CLAUDE_PROJECT_DIR/tools/perm-guard.sh"');
    expect(hook.strength).toBe("refuse");
  });
});

describe("everything else is as before", () => {
  it("a detect hook on PermissionRequest runs its script as written, with an exit 1 stub", () => {
    expect(commandOf(SOURCE("detect"))).toBe('bash "$CLAUDE_PROJECT_DIR/tools/perm-guard.sh"');
    const f = scaffold(SOURCE("detect")).find((x) => x.path === "tools/perm-guard.sh")!;
    expect(f.content).toMatch(/^exit 1$/m);
  });

  it("guard --check grades a cited refuse PermissionRequest hook like other refusing hooks: none while a stub", () => {
    const { root } = run(SOURCE());
    const item = checkGuards(parse(SOURCE()), root).items.find((i) => i.kind === "gate" && i.id === "g1")!;
    expect(item.strength).toBe("none");
    expect(item.notes.join(" ")).toContain("is still a stub");
  });

  it("guard --check grades it refuse (cited, not proven) once the script is written", () => {
    const { root } = run(SOURCE(), "#!/usr/bin/env bash\nexit 0\n");
    const item = checkGuards(parse(SOURCE()), root).items.find((i) => i.kind === "gate" && i.id === "g1")!;
    expect(item.strength).toBe("refuse");
    expect(item.notes).toContain("cited, not proven");
  });
});

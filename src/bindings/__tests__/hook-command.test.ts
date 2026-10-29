/**
 * A command hook's `run:` → the settings.json command.
 *
 * Before: a project path ("./x/y.py --flag") was run by bash whatever its
 * extension, and relative to the hook's cwd, which is the session's and moves.
 * Now it runs by its extension's interpreter through $CLAUDE_PROJECT_DIR.
 */

import { describe, it, expect } from "vitest";
import { parse } from "../../parser/index.js";
import { hookCommand, settingsHooksOf } from "../claude-code.js";
import { bindings } from "../index.js";

describe("hookCommand", () => {
  it("runs a project .py path by python3 from the project root, arguments kept", () => {
    expect(hookCommand("./harness-plugin/hooks/router.py --pane", "t")).toBe(
      'python3 "$CLAUDE_PROJECT_DIR/harness-plugin/hooks/router.py" --pane',
    );
  });

  it("runs a dotted .sh path by bash from the project root", () => {
    expect(hookCommand(".claude/hooks/gates/gate.sh", "t")).toBe('bash "$CLAUDE_PROJECT_DIR/.claude/hooks/gates/gate.sh"');
    expect(hookCommand("./scripts/x.sh", "t")).toBe('bash "$CLAUDE_PROJECT_DIR/scripts/x.sh"');
  });

  it("runs by the interpreter the run: names, kept as written", () => {
    expect(hookCommand("/opt/homebrew/bin/python3 ./harness-plugin/hooks/router.py --pane", "t")).toBe(
      '/opt/homebrew/bin/python3 "$CLAUDE_PROJECT_DIR/harness-plugin/hooks/router.py" --pane',
    );
    expect(hookCommand("sh .claude/x.sh", "t")).toBe('sh "$CLAUDE_PROJECT_DIR/.claude/x.sh"');
  });

  it("keeps an absolute path as written", () => {
    expect(hookCommand("/opt/x/y.py -q", "t")).toBe("python3 /opt/x/y.py -q");
  });

  it("keeps any other run: in the skill's scripts folder by basename, as before", () => {
    expect(hookCommand("gate.sh", "mini")).toBe("bash .claude/skills/mini/scripts/gate.sh");
    expect(hookCommand("scripts/post-write.sh", "mini")).toBe("bash .claude/skills/mini/scripts/post-write.sh");
  });
});

describe("settingsHooksOf", () => {
  const ast = parse(
    [
      "topology mini : [pipeline] {",
      "  meta {",
      '    version: "1.0.0"',
      '    description: "hooks"',
      "  }",
      "  orchestrator {",
      "    model: sonnet",
      "  }",
      "  agent a {",
      "    model: sonnet",
      '    description: "a"',
      "  }",
      "  flow { a }",
      "  hooks {",
      "    hook pane {",
      "      on: PreToolUse",
      '      matcher: "SendMessage"',
      '      run: "./harness-plugin/hooks/router.py --pane"',
      "      type: command",
      "      timeout: 3",
      "    }",
      "    hook stop {",
      "      on: Stop",
      '      run: "/opt/homebrew/bin/python3 .claude/hooks/end_check.py"',
      "      type: command",
      "    }",
      "    hook redact {",
      "      on: tool.call",
      '      run: "harness-plugin/hooks/register.ts"',
      "      type: mod",
      "      flag: X",
      "    }",
      "  }",
      "}",
    ].join("\n"),
  );

  it("emits the command hooks only, with matcher and timeout (seconds, as written)", () => {
    expect(settingsHooksOf(ast)).toEqual({
      PreToolUse: [
        {
          matcher: "SendMessage",
          hooks: [{ type: "command", command: 'python3 "$CLAUDE_PROJECT_DIR/harness-plugin/hooks/router.py" --pane', timeout: 3 }],
        },
      ],
      Stop: [{ hooks: [{ type: "command", command: '/opt/homebrew/bin/python3 "$CLAUDE_PROJECT_DIR/.claude/hooks/end_check.py"' }] }],
    });
  });

  it("writes a dotted hook's stub at its path, never at a path holding its arguments", () => {
    const paths = bindings["claude-code"].scaffold(ast).map((f) => f.path);
    expect(paths).toContain("./harness-plugin/hooks/router.py");
    expect(paths.some((p) => p.includes("--pane"))).toBe(false);
    expect(paths).toContain(".claude/hooks/end_check.py");
    expect(paths.some((p) => p.includes("homebrew")), "never a stub at the interpreter").toBe(false);
  });
});

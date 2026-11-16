/**
 * The two scaffold-side differences 0.11.3 keeps from main (ruled: S-12 and
 * S-13), as sequences frozen from v0.11.2 (exceptions-0112.json, by
 * freeze-merge.mjs's runner). The test asserts each one's exact difference,
 * and that nothing else differs.
 */

const SCRIPT = "#!/bin/bash\nexit 0\n";

export const S12_HOOK = "python3 .claude/skills/auto/references/guard.py --strict";
export const S13_KEYS = ["bucket", "output-bucket"];

export const EXCEPTION_SEQUENCES = [
  {
    name: "S-12: a hook running the user's script inside a file: authored skill folder",
    setup: {
      ".claude/skills/auto/SKILL.md": "---\nname: auto\ndescription: Runs the release.\n---\n\nDo the release.\n",
      ".claude/skills/auto/references/guard.py": "import sys\nsys.exit(0)\n",
    },
    steps: [{
      at: [
        "topology pilot : [] {",
        "  meta {",
        '    version: "1.0.0"',
        "  }",
        "  hooks {",
        "    hook guard {",
        "      on: PreToolUse",
        '      matcher: "Edit|Write"',
        `      run: ${JSON.stringify(S12_HOOK)}`,
        "      type: command",
        "    }",
        "  }",
        "  skills {",
        "    skill auto {",
        "      file: .claude/skills/auto/SKILL.md",
        '      description: "Runs the release."',
        "    }",
        "  }",
        "}",
        "",
      ].join("\n"),
      run: ["scaffold", "t.at", "--target", "claude-code"],
    }],
  },
  {
    name: "S-13: environments values do not leak into settings.json env",
    setup: { "x.sh": SCRIPT },
    steps: [{
      at: [
        "topology envs : [pipeline] {",
        "  meta {",
        '    version: "1.0.0"',
        '    description: "envs"',
        "  }",
        "  orchestrator {",
        "    model: sonnet",
        "  }",
        "  agent a {",
        "    model: sonnet",
        '    description: "a"',
        "  }",
        "  agent b {",
        "    model: sonnet",
        '    description: "b"',
        "  }",
        "  flow { a -> b }",
        "  environments {",
        "    production {",
        '      bucket: "s3://prod-data"',
        '      output-bucket: "s3://prod-out"',
        "    }",
        "  }",
        "  hooks {",
        "    hook g {",
        "      on: PreToolUse",
        '      matcher: "Bash"',
        '      run: "scripts/guard.sh"',
        "      type: command",
        "    }",
        "  }",
        "}",
        "",
      ].join("\n"),
      run: ["scaffold", "t.at", "--target", "claude-code"],
    }],
  },
];

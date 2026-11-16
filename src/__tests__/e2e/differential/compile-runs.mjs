/**
 * Compile one hook or gate `run:` with a built agentopology (a dist/ folder)
 * and record what it resolves to, for the 0.11.2 differential test.
 *
 * The same code runs against v0.11.2's dist (to freeze runs-0112.json) and
 * against this branch's dist (the test), so both sides are read the same way.
 *
 * Per run and kind (hook or gate), per target (claude-code, codex):
 *   - refused: validate reports V96 on it, or a path scaffold would write is
 *     not a safe file name (scaffold refuses: "not safe file names")
 *   - command: the settings.json / hooks.json command (hook), or the gate
 *     wrapper's command line (gate); null when none is emitted
 *   - stubs: the stub scripts it adds (paths)
 *
 * Plain JavaScript on purpose: it loads either dist by path.
 */

import { pathToFileURL } from "node:url";
import { join } from "node:path";

/** The .at a run is compiled in: a declared bare script (`check-review`, by a second hook) and the run as hook h or gate g. */
export function atFor(kind, run, model = "sonnet") {
  const runLit = JSON.stringify(run);
  return [
    "topology t : [pipeline] {",
    "  meta {",
    '    version: "1.0.0"',
    '    description: "differential"',
    "  }",
    "  orchestrator {",
    `    model: ${model}`,
    "  }",
    "  agent a {",
    `    model: ${model}`,
    '    description: "a"',
    "  }",
    "  agent b {",
    `    model: ${model}`,
    '    description: "b"',
    "  }",
    "  flow { a -> b }",
    ...(kind === "gate"
      ? ["  gates {", "    gate g {", "      after: a", "      before: b", `      run: ${runLit}`, "    }", "  }"]
      : []),
    "  hooks {",
    "    hook decl {",
    "      on: PostToolUse",
    '      matcher: "Edit"',
    '      run: "check-review"',
    "      type: command",
    "    }",
    ...(kind === "hook"
      ? ["    hook h {", "      on: PreToolUse", '      matcher: "Bash"', `      run: ${runLit}`, "      type: command", "    }"]
      : []),
    "  }",
    "}",
  ].join("\n");
}

export async function loadLib(dist) {
  const imp = (p) => import(pathToFileURL(join(dist, p)).href);
  const [{ parse }, { validate }, { bindings }, { unsafePathReason }] = await Promise.all([
    imp("parser/index.js"),
    imp("parser/validator.js"),
    imp("bindings/index.js"),
    imp("parser/paths.js"),
  ]);
  return { parse, validate, bindings, unsafePathReason };
}

const STUB = "AGENTOPOLOGY_STUB";
const CODEX_MODEL = "gpt-5.2";
const GATE_LINE = /^\s*(.*?) \|\| GATE_RESULT=\$\?\s*$/m;

function silently(fn) {
  const warn = console.warn;
  console.warn = () => {};
  try {
    return fn();
  } finally {
    console.warn = warn;
  }
}

function emitted(lib, target, ast, kind, baseline) {
  let files;
  try {
    files = silently(() => lib.bindings[target].scaffold(ast));
  } catch (e) {
    return { refused: true, command: null, stubs: [], error: String(e.message ?? e).slice(0, 160) };
  }
  const unsafe = files.some((f) => lib.unsafePathReason(String(f.path).replace(/^\.\//, "")) !== null);
  const stubs = files.filter((f) => !baseline.has(f.path) && String(f.content).includes(STUB)).map((f) => f.path).sort();
  let command = null;
  if (kind === "gate") {
    const wrapper = files.find((f) => /(^|\/)gate-g\.sh$/.test(f.path));
    const m = wrapper && GATE_LINE.exec(wrapper.content);
    command = m ? m[1] : null;
  } else {
    const cfg = files.find((f) => f.path === (target === "codex" ? ".codex/hooks.json" : ".claude/settings.json"));
    const pre = cfg ? JSON.parse(cfg.content).hooks?.PreToolUse ?? [] : [];
    const cmds = pre.flatMap((g) => (g.hooks ?? []).map((h) => h.command ?? h.prompt ?? ""));
    command = cmds.length ? cmds.join(" ;; ") : null;
  }
  return { refused: unsafe, command, stubs };
}

/** What `run` compiles to as a hook or a gate, per target. */
export function compileRun(lib, kind, run, baselines) {
  let ast;
  try {
    ast = lib.parse(atFor(kind, run));
  } catch {
    // The .at does not parse (a lone brace in the run): nothing compiles.
    return { v96: false, parseError: true, refused: true };
  }
  const owner = kind === "gate" ? 'Gate "g"' : 'Hook "h"';
  const v96 = lib.validate(ast).some((r) => r.rule === "V96" && r.level === "error" && r.message.startsWith(owner));
  const out = { v96 };
  out["claude-code"] = emitted(lib, "claude-code", ast, kind, baselines["claude-code"]);
  // Codex runs no Claude model: the same .at with a Codex one.
  out.codex = emitted(lib, "codex", lib.parse(atFor(kind, run, CODEX_MODEL)), kind, baselines.codex);
  out.refused = v96 || out["claude-code"].refused;
  return out;
}

/** The files a target scaffolds for the .at with a plain run, so a run's own stubs can be told apart. */
export function baselinesFor(lib) {
  const out = {};
  for (const target of ["claude-code", "codex"]) {
    const ast = lib.parse(atFor("hook", "true", target === "codex" ? CODEX_MODEL : "sonnet"));
    out[target] = new Set(silently(() => lib.bindings[target].scaffold(ast)).map((f) => f.path));
  }
  return out;
}

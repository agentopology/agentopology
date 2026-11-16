/**
 * Compile one hook or gate `run:` with a built agentopology (a dist/ folder)
 * and record what it resolves to, for the 0.11.2 differential test.
 *
 * The same code runs against v0.11.2's dist (to freeze runs-0112.json) and
 * against this branch's dist (the test), so both sides are read the same way.
 *
 * A row is a run placed as a topology hook ("hook"), a gate ("gate") or an
 * agent's own hook ("agent-hook"). Its value is written into the .at as a JSON
 * string, or, for parser shapes, as the literal .at text `lit` (with
 * backslashes, braces, `#` as written), and the whole .at may use CRLF.
 *
 * Per row:
 *   - refused: validate reports V96 on it, a path scaffold would write is not
 *     a safe file name, or the .at does not parse
 *   - claude-code / codex: the command (settings.json / hooks.json for a hook,
 *     the gate wrapper's command line for a gate, the agent file's hook lines
 *     for an agent hook) and the stubs it adds
 *   - files: per target (claude-code, codex, cursor, claude-workflow), one
 *     digest of every generated file that differs from the baseline .at's:
 *     gate wrapper bodies, agent files, cursor hooks, all of it
 *   - step: for a gate, what `step check` reports (its run is executed; the
 *     tail of its output, which names the machine's paths, is cut)
 *
 * Plain JavaScript on purpose: it loads either dist by path.
 */

import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import { join } from "node:path";

export const TARGETS = ["claude-code", "codex", "cursor", "claude-workflow"];
const CODEX_MODEL = "gpt-5.2";
const STUB = "AGENTOPOLOGY_STUB";
const GATE_LINE = /^\s*(.*?) \|\| GATE_RESULT=\$\?\s*$/m;

/** The .at a run is compiled in: a declared bare script (`check-review`, by a second hook) and the run as hook h, gate g, or agent a's hook ah. */
export function atFor(kind, run, model = "sonnet", opts = {}) {
  const runLit = opts.lit ?? JSON.stringify(run);
  const hook = (id, ind) => [`${ind}hook ${id} {`, `${ind}  on: PreToolUse`, `${ind}  matcher: "Bash"`, `${ind}  run: ${runLit}`, `${ind}  type: command`, `${ind}}`];
  const text = [
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
    ...(kind === "agent-hook" ? ["    hooks {", ...hook("ah", "      "), "    }"] : []),
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
    ...(kind === "hook" ? hook("h", "    ") : []),
    "  }",
    "}",
  ].join("\n");
  return opts.crlf ? text.replace(/\n/g, "\r\n") : text;
}

export async function loadLib(dist) {
  const imp = (p) => import(pathToFileURL(join(dist, p)).href);
  const [{ parse }, { validate }, { bindings }, { unsafePathReason }, { checkStep, renderStepReport }] = await Promise.all([
    imp("parser/index.js"),
    imp("parser/validator.js"),
    imp("bindings/index.js"),
    imp("parser/paths.js"),
    imp("step/check.js"),
  ]);
  return { parse, validate, bindings, unsafePathReason, checkStep, renderStepReport };
}

function silently(fn) {
  const warn = console.warn;
  console.warn = () => {};
  try {
    return fn();
  } finally {
    console.warn = warn;
  }
}

const sha = (s) => createHash("sha256").update(s).digest("hex");

function scaffoldOf(lib, target, ast) {
  try {
    return { files: silently(() => lib.bindings[target].scaffold(ast)) };
  } catch (e) {
    return { error: String(e.message ?? e).slice(0, 200) };
  }
}

/** One digest of the files that differ from the baseline (added, changed or gone). */
function filesDigest(files, baseline) {
  const now = new Map(files.map((f) => [f.path, sha(String(f.content))]));
  const parts = [];
  for (const [p, h] of [...now].sort()) if (baseline.get(p) !== h) parts.push(`${p}\u0000${h}`);
  for (const p of [...baseline.keys()].sort()) if (!now.has(p)) parts.push(`${p}\u0000gone`);
  return sha(parts.join("\n")).slice(0, 16);
}

function commandOf(files, target, kind) {
  if (kind === "gate") {
    const wrapper = files.find((f) => /(^|\/)gate-g\.sh$/.test(f.path));
    const m = wrapper && GATE_LINE.exec(wrapper.content);
    return m ? m[1] : null;
  }
  if (kind === "agent-hook") {
    const agent = files.find((f) => /(^|\/)agents\/a(\/AGENT\.md|\.md|\.toml)$/.test(f.path));
    if (!agent) return null;
    const lines = String(agent.content).split("\n").filter((l) => /command|run|hook/i.test(l) && /\S/.test(l));
    return lines.length ? lines.join("\n") : null;
  }
  const cfg = files.find((f) => f.path === (target === "codex" ? ".codex/hooks.json" : ".claude/settings.json"));
  const pre = cfg ? JSON.parse(cfg.content).hooks?.PreToolUse ?? [] : [];
  const cmds = pre.flatMap((g) => (g.hooks ?? []).map((h) => h.command ?? h.prompt ?? ""));
  return cmds.length ? cmds.join(" ;; ") : null;
}

/** What `step check t.at b` reports for the gate: executed in an empty folder; output tails and paths cut. */
function stepCheck(lib, ast, run) {
  // Runs that would need a tool this machine may lack, or that write outside the folder, are not executed.
  if (/\b(bun|deno)\b|\/tmp\//.test(run)) return "skipped";
  const dir = fs.mkdtempSync(join(os.tmpdir(), "at-step-"));
  try {
    const report = lib.checkStep(ast, "b", { dir, today: "2026-01-01" });
    return lib.renderStepReport(report)
      .map((l) => l.split(dir).join("<DIR>").replace(/(exited \d+|did not finish): .*$/, "$1"))
      .join("\n");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** What `run` compiles to as a hook, a gate or an agent hook, per target. */
export function compileRun(lib, kind, run, baselines, opts = {}) {
  const parseFor = (model) => {
    try {
      return lib.parse(atFor(kind, run, model, opts));
    } catch {
      return null;
    }
  };
  const ast = parseFor("sonnet");
  // The .at does not parse (a lone brace in the run): nothing compiles.
  if (!ast) return { v96: false, parseError: true, refused: true };
  const owner = kind === "gate" ? 'Gate "g"' : kind === "agent-hook" ? 'Hook "ah"' : 'Hook "h"';
  const v96 = lib.validate(ast).some((r) => r.rule === "V96" && r.level === "error" && r.message.startsWith(owner));
  const out = { v96 };
  const files = {};
  for (const target of TARGETS) {
    // Codex runs no Claude model: the same .at with a Codex one.
    const tast = target === "codex" ? parseFor(CODEX_MODEL) : ast;
    const s = scaffoldOf(lib, target, tast);
    if (s.error) {
      files[target] = `error: ${s.error}`;
      if (target === "claude-code" || target === "codex") out[target] = { refused: true, command: null, stubs: [], error: s.error };
      continue;
    }
    files[target] = filesDigest(s.files, baselines[target]);
    if (target === "claude-code" || target === "codex") {
      const unsafe = s.files.some((f) => lib.unsafePathReason(String(f.path).replace(/^\.\//, "")) !== null);
      const stubs = s.files.filter((f) => !baselines[target].has(f.path) && String(f.content).includes(STUB)).map((f) => f.path).sort();
      const command = commandOf(s.files, target, kind);
      // Codex's command opens with a long root-finding prelude: kept as a digest, the files digest covers the rest.
      out[target] = { refused: unsafe, command: target === "codex" && command ? `sha:${sha(command).slice(0, 16)}` : command, stubs };
    }
  }
  out.files = files;
  if (kind === "gate") out.step = stepCheck(lib, ast, run ?? opts.lit ?? "");
  out.refused = v96 || out["claude-code"].refused;
  return out;
}

/** The files each target scaffolds for the .at with a plain run: a row's changes are told apart from these. */
export function baselinesFor(lib) {
  const out = {};
  for (const target of TARGETS) {
    const ast = lib.parse(atFor("hook", "true", target === "codex" ? CODEX_MODEL : "sonnet"));
    out[target] = new Map(silently(() => lib.bindings[target].scaffold(ast)).map((f) => [f.path, sha(String(f.content))]));
  }
  return out;
}

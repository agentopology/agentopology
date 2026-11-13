/**
 * [CX-17] `guard <file> --target codex` writes only the guard part of what the
 * Codex scaffold writes, into a project built by hand: the guard scripts and
 * the hooks in .codex/hooks.json, merged. It never writes or edits AGENTS.md,
 * config.toml, agent files or skills; the user's hook entry and file stay; a
 * rerun changes nothing.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import { createHash } from "node:crypto";
import { resolve, dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "../../parser/index.js";
import { codexBinding } from "../../bindings/codex.js";
import { guardFiles } from "../../guard/target.js";

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolve(here, "fixtures/codex-gates.at");
const CLI = resolve(here, "../../../dist/cli/index.js");
const ast = parse(fs.readFileSync(FIXTURE, "utf-8"));
const S = ".codex/scripts/ship";
const USER_AGENTS = "# My project\n\nDo not touch this. Hand-written.\n";
const USER_HOOKS = { hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "bash my-own-hook.sh", timeout: 5 }] }] } };
const USER_GATE = "#!/usr/bin/env bash\n# mine, implemented\nexit 0\n";

let root: string;
const at = (p: string) => join(root, p);
const hooksJson = () => JSON.parse(fs.readFileSync(at(".codex/hooks.json"), "utf8"));
const cli = (...a: string[]) => spawnSync("node", [CLI, "guard", FIXTURE, "--target", "codex", "--dir", root, ...a], { encoding: "utf8" });

function snapshot(): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) { out[relative(root, p) + "/"] = ""; walk(p); }
      else out[relative(root, p)] = createHash("sha256").update(fs.readFileSync(p)).digest("hex");
    }
  };
  walk(root);
  return out;
}

beforeEach(() => {
  root = fs.mkdtempSync(join(os.tmpdir(), "at-cx17-"));
  fs.writeFileSync(at("AGENTS.md"), USER_AGENTS);
  fs.mkdirSync(at(".codex/scripts"), { recursive: true });
  fs.writeFileSync(at(".codex/hooks.json"), JSON.stringify(USER_HOOKS, null, 2));
  fs.writeFileSync(at(".codex/scripts/render-check.sh"), USER_GATE);
});

describe("[CX-17] guard --target codex", () => {
  it("[CX-17] keeps the guard scripts, the gates they call and hooks.json, and nothing else", () => {
    const paths = guardFiles(codexBinding.scaffold(ast), "codex").map((f) => f.path).sort();
    expect(paths).toContain(`${S}/before-action.sh`);
    expect(paths).toContain(`${S}/before-agent.sh`);
    expect(paths).toContain(`${S}/gate-render-check.sh`);
    expect(paths).toContain(".codex/hooks.json");
    expect(paths.filter((p) => p === "AGENTS.md" || p === ".codex/config.toml" || p.startsWith(".codex/agents/") || p.startsWith(".agents/"))).toEqual([]);
  });

  it("[CX-17] merges the guards in: the user's hook entry and file are still there", () => {
    const r = cli();
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("/hooks");
    expect(fs.readFileSync(at("AGENTS.md"), "utf8")).toBe(USER_AGENTS);
    const pre = hooksJson().hooks.PreToolUse as Array<{ matcher: string; hooks: Array<{ command: string }> }>;
    expect(pre.some((e) => e.hooks[0].command === "bash my-own-hook.sh")).toBe(true);
    expect(pre.some((e) => e.matcher === "Bash" && e.hooks[0].command.includes("before-action.sh"))).toBe(true);
    expect(pre.some((e) => e.matcher === "collaborationspawn_agent")).toBe(true);
    expect(fs.existsSync(at(`${S}/before-action.sh`))).toBe(true);
    expect(fs.statSync(at(`${S}/before-action.sh`)).mode & 0o111).not.toBe(0);
    for (const p of [".codex/config.toml"]) expect(fs.existsSync(at(p))).toBe(false);
    expect(fs.existsSync(at(".codex/agents"))).toBe(false);
    expect(fs.readFileSync(at(".codex/scripts/render-check.sh"), "utf8")).toBe(USER_GATE);
  });

  it("[CX-17] a second run changes nothing", () => {
    expect(cli().status).toBe(0);
    const first = snapshot();
    expect(cli().status).toBe(0);
    expect(snapshot()).toEqual(first);
  });

  it("[CX-17] --dry-run writes nothing", () => {
    const before = snapshot();
    const r = cli("--dry-run");
    expect(r.status).toBe(0);
    expect(snapshot()).toEqual(before);
  });

  it("[CX-17] a Claude model name is refused with nothing written", () => {
    const bad = join(root, "claude.at");
    fs.writeFileSync(bad, fs.readFileSync(FIXTURE, "utf8").replace(/gpt-5\.2/g, "sonnet"));
    const before = snapshot();
    const r = spawnSync("node", [CLI, "guard", bad, "--target", "codex", "--dir", root], { encoding: "utf8" });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/Claude model/);
    expect(fs.readFileSync(at(".codex/hooks.json"), "utf8")).toBe(JSON.stringify(USER_HOOKS, null, 2));
    expect(Object.keys(snapshot())).toEqual(Object.keys(before));
  });

  it("[CX-17] other targets are still refused; claude-code is unchanged", () => {
    const r = spawnSync("node", [CLI, "guard", FIXTURE, "--target", "gemini-cli", "--dir", root], { encoding: "utf8" });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/claude-code and codex/);
  });
});

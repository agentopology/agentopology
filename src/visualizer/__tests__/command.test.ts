import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse } from "../../parser/index.js";
import { claudeCodeBinding } from "../../bindings/claude-code.js";
import { openerFor, pickTopology, summaryLines } from "../command.js";
import { collectFacts } from "../facts.js";
import { generateVisualization } from "../index.js";
import { drawPage } from "./vm-draw.js";

const ROOT = path.resolve(__dirname, "../../..");
const CLI = path.join(ROOT, "dist/cli/index.js");
const EX = path.join(ROOT, "examples/code-review.at");
const tmp = (p: string) => fs.mkdtempSync(path.join(os.tmpdir(), p));

function run(cwd: string, home: string, ...args: string[]) {
  // A fake opener on PATH records any attempt to open a browser.
  const bin = tmp("at-vz11-bin-");
  const log = path.join(bin, "opened.log");
  for (const o of ["open", "xdg-open", "wslview"]) fs.writeFileSync(path.join(bin, o), `#!/bin/sh\necho "$0 $@" >> "${log}"\n`, { mode: 0o755 });
  const r = spawnSync(process.execPath, [CLI, "visualize", ...args], {
    cwd, encoding: "utf8", env: { ...process.env, HOME: home, XDG_CACHE_HOME: "", PATH: `${bin}:${path.dirname(process.execPath)}:/usr/bin:/bin`, NO_COLOR: "1" },
  });
  return { ...r, opened: fs.existsSync(log) ? fs.readFileSync(log, "utf8") : "" };
}

describe("[VZ11] the opener per platform", () => {
  it("[VZ11] open on macOS, xdg-open on Linux, start on Windows", () => {
    expect(openerFor("darwin", {}, "").cmd).toBe("open");
    expect(openerFor("linux", {}, "Linux version 6.1").cmd).toBe("xdg-open");
    const w = openerFor("win32", {}, "");
    expect(w.cmd).toBe("cmd");
    expect(w.args.slice(0, 3)).toEqual(["/c", "start", '""']);
  });
  it("[VZ11] wslview when WSL is detected", () => {
    expect(openerFor("linux", {}, "Linux version 5.15 microsoft-standard-WSL2").cmd).toBe("wslview");
    expect(openerFor("linux", { WSL_DISTRO_NAME: "Ubuntu" }, "").cmd).toBe("wslview");
  });
});

describe("[VZ11] picking the file", () => {
  it("[VZ11] the only .at in cwd", () => {
    const d = tmp("at-vz11-pick-");
    fs.copyFileSync(EX, path.join(d, "a.at"));
    expect(pickTopology(d)).toEqual({ file: path.join(d, "a.at") });
  });
  it("[VZ11] the only .at in .claude/topologies/ when cwd has none", () => {
    const d = tmp("at-vz11-pick-");
    fs.mkdirSync(path.join(d, ".claude/topologies"), { recursive: true });
    fs.copyFileSync(EX, path.join(d, ".claude/topologies/b.at"));
    expect(pickTopology(d)).toEqual({ file: path.join(d, ".claude/topologies/b.at") });
  });
  it("[VZ11] none or several is an error that names the choices", () => {
    const d = tmp("at-vz11-pick-");
    expect(pickTopology(d).error).toMatch(/no \.at file/);
    fs.copyFileSync(EX, path.join(d, "a.at"));
    fs.copyFileSync(EX, path.join(d, "b.at"));
    const e = pickTopology(d).error!;
    expect(e).toMatch(/more than one/);
    expect(e).toContain("a.at");
    expect(e).toContain("b.at");
  });
});

describe("[VZ11] visualize command", () => {
  it("[VZ11] no file argument, no -o: writes to ~/.cache/agentopology/visualize/ and --no-open opens nothing", () => {
    const cwd = tmp("at-vz11-cwd-");
    const home = tmp("at-vz11-home-");
    fs.copyFileSync(EX, path.join(cwd, "only.at"));
    const r = run(cwd, home, "--no-open");
    expect(r.status).toBe(0);
    expect(fs.existsSync(path.join(home, ".cache/agentopology/visualize/only-topology.html"))).toBe(true);
    expect(fs.existsSync(path.join(cwd, "only-topology.html"))).toBe(false);
    expect(r.opened).toBe("");
  });
  it("[VZ11] with --dir the page carries checked facts; --no-check leaves them not checked", () => {
    const cwd = tmp("at-vz11-cwd-");
    const home = tmp("at-vz11-home-");
    const proj = tmp("at-vz11-proj-");
    for (const f of claudeCodeBinding.scaffold(parse(fs.readFileSync(EX, "utf8")))) {
      fs.mkdirSync(path.dirname(path.join(proj, f.path)), { recursive: true });
      fs.writeFileSync(path.join(proj, f.path), f.content);
    }
    const out = path.join(cwd, "out");
    expect(run(cwd, home, EX, "--dir", proj, "-o", out, "--no-open").status).toBe(0);
    expect(fs.readFileSync(path.join(out, "code-review-topology.html"), "utf8")).toContain('"checked":true');
    const out2 = path.join(cwd, "out2");
    expect(run(cwd, home, EX, "--dir", proj, "--no-check", "-o", out2, "--no-open").status).toBe(0);
    expect(fs.readFileSync(path.join(out2, "code-review-topology.html"), "utf8")).toContain('"checked":false');
    const out3 = path.join(cwd, "out3");
    run(cwd, home, EX, "-o", out3, "--no-open");
    expect(fs.readFileSync(path.join(out3, "code-review-topology.html"), "utf8")).toContain('"checked":false');
  });
  it("[VZ11] --print-summary prints node counts and facts to stdout", () => {
    const cwd = tmp("at-vz11-cwd-");
    const r = run(cwd, tmp("at-vz11-home-"), EX, "--print-summary", "--no-open", "-o", path.join(cwd, "o"));
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/nodes: \d+/);
    expect(r.stdout).toMatch(/edges: \d+/);
    expect(r.stdout).toContain("facts: not checked");
  });
  it("[VZ11] summaryLines lists counts by kind and the checked facts", () => {
    const ast = parse(fs.readFileSync(EX, "utf8"));
    const f = collectFacts(ast, { source: "x", dir: ROOT });
    const lines = summaryLines(ast, f);
    expect(lines.join("\n")).toMatch(/nodes: \d+ \(/);
    expect(lines.join("\n")).toContain("facts: checked");
    expect(lines.join("\n")).toMatch(/validate: \d+ error\(s\), \d+ warning\(s\)/);
  });
  it("[VZ11] the page script runs with facts embedded", () => {
    const src = fs.readFileSync(EX, "utf8");
    const ast = parse(src);
    expect(() => drawPage(generateVisualization(ast, { facts: collectFacts(ast, { source: src, dir: ROOT }) }))).not.toThrow();
  });
});

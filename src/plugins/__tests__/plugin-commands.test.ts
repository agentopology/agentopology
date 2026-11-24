/**
 * Plugin commands and report rows (EXPERIMENTAL), with the generic `acme` fixture plugin.
 *
 * A plugin's `commands` run as `agentopology <pluginId>:<name>`: namespaced, so they never shadow a core command.
 * Its `guardReport` rows are printed by `guard --check` after the core rows, as `plugin <id> claimed: …`; they are
 * never part of the core's enforcement total and the exit code stays the core's. Runs the built CLI.
 */

import { describe, it, expect, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { checkPlugin, PluginError } from "../runtime.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../../..");
const CLI = resolve(root, "dist/cli/index.js");
const ACME = join(here, "fixtures/acme.mjs");

function run(args: string[], cwd = root): { out: string; err: string; code: number } {
  const r = spawnSync("node", [CLI, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], cwd });
  return { out: r.stdout ?? "", err: r.stderr ?? "", code: r.status ?? 1 };
}

const AT = `topology w : [pipeline] {
  meta {
    version: "1.0.0"
    description: "widgets"
  }
  orchestrator {
    model: sonnet
  }
  agent a {
    model: sonnet
    prompt { Do a. }
  }
  agent b {
    model: sonnet
    prompt { Do b. }
  }
  flow {
    a -> b
  }
  gates {
    gate g {
      after: a
      before: b
      extensions {
        acme { }
      }
    }
  }
  widget w1 {
    a: "one"
  }
}
`;

const dirs: string[] = [];
const project = (): string => {
  const d = mkdtempSync(join(tmpdir(), "at-plugin-cmd-"));
  dirs.push(d);
  writeFileSync(join(d, "w.at"), AT);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("plugin commands", () => {
  it("runs as <id>:<name> with its arguments and returns its exit code", () => {
    const d = project();
    const r = run(["acme:hello", "x", "y", "--dir", d, "--plugin", ACME]);
    expect(r.out).toContain("acme hello x|y in acme");
    expect(r.code).toBe(0);
    expect(run(["acme:fail", "--dir", d, "--plugin", ACME]).code).toBe(3);
  });

  it("a plugin that is not loaded is an error that says how to load it", () => {
    const r = run(["acme:hello"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("plugin acme is not loaded; run with --plugin acme");
  });

  it("a name the plugin does not have is an error", () => {
    const r = run(["acme:nope", "--plugin", ACME]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("plugin acme has no command nope");
  });

  it("a command that does not return a whole number is an error", () => {
    const r = run(["acme:bad", "--plugin", ACME]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("plugin acme: command bad did not return an exit code");
  });

  it("never shadows a core command: acme:validate runs the plugin's, validate runs the core's", () => {
    const d = project();
    expect(run(["acme:validate", "--plugin", ACME]).code).toBe(0);
    const core = run(["validate", join(d, "w.at")]);
    expect(core.code).toBe(1);
    expect(core.out).toContain("[V102]");
  });

  it("a command name that is not a word, or has a colon, is refused when the plugin loads", () => {
    const base = { id: "acme", apiVersion: 1 as const, blocks: {} };
    expect(() => checkPlugin({ ...base, commands: { "a:b": () => 0 } })).toThrow(PluginError);
    expect(() => checkPlugin({ ...base, commands: { "Bad Name": () => 0 } })).toThrow(PluginError);
    expect(() => checkPlugin({ ...base, commands: { ok: "no" } })).toThrow(PluginError);
    expect(() => checkPlugin({ ...base, commands: { ok: () => 0 } })).not.toThrow();
  });
});

describe("plugin report rows in guard --check", () => {
  it("prints the plugin's rows after the core rows, marked claimed, and changes nothing else", () => {
    const d = project();
    const withRows = run(["guard", join(d, "w.at"), "--check", "--dir", d, "--plugin", ACME]);
    const rows = withRows.out.split("\n").filter((l) => l.startsWith("plugin acme"));
    expect(rows).toEqual(["plugin acme claimed: widgets 1, nodes 3, target claude-code"]);

    // The same plugin with its guardReport switched off: the core's output and exit code are the same.
    const off = join(d, "acme-off.mjs");
    writeFileSync(off, readFileSync(ACME, "utf8").replace("guardReport(", "guardReportOff("));
    const without = run(["guard", join(d, "w.at"), "--check", "--dir", d, "--plugin", off]);
    expect(withRows.code).toBe(without.code);
    const core = (s: string) => s.split("\n").filter((l) => !l.startsWith("plugin acme")).join("\n").replace(/\n+$/, "");
    expect(core(withRows.out).replace(/\n+$/, "")).toBe(core(without.out));
    expect(without.out).not.toContain("plugin acme");
  });

  it("the rows come after every core row, islands included", () => {
    const d = project();
    const r = run(["guard", join(d, "w.at"), "--check", "--dir", d, "--plugin", ACME]);
    const lines = r.out.split("\n").filter((l) => l.length > 0);
    expect(lines[lines.length - 1].startsWith("plugin acme claimed:")).toBe(true);
  });

  it("with no plugin loaded no row is printed", () => {
    const d = project();
    mkdirSync(join(d, ".claude"), { recursive: true });
    const r = run(["guard", join(d, "w.at"), "--check", "--dir", d]);
    expect(r.out).not.toContain("plugin acme");
  });
});

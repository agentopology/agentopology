/**
 * Plumbing for `agentopology visualize`: which file to draw, where the page
 * goes, how to open it, and the stdout summary. Pure where it can be, so the
 * tests never open a browser.
 *
 * @module
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { TopologyAST } from "../parser/ast.js";
import type { Facts } from "./facts.js";
import { LEDGER_WRITABLE_NOTE } from "../bindings/lib/guards.js";

/** `~/.cache/agentopology/visualize/` */
export function defaultOutputDir(home: string = os.homedir()): string {
  return path.join(home, ".cache", "agentopology", "visualize");
}

/** The only `.at` in `cwd`, else the only one in `.claude/topologies/`. */
export function pickTopology(cwd: string): { file?: string; error?: string } {
  const found: string[] = [];
  for (const dir of [cwd, path.join(cwd, ".claude", "topologies")]) {
    let names: string[] = [];
    try { names = fs.readdirSync(dir).filter((f) => f.endsWith(".at")).sort(); } catch { /* no such dir */ }
    if (names.length === 1 && found.length === 0) return { file: path.join(dir, names[0]) };
    found.push(...names.map((n) => path.relative(cwd, path.join(dir, n))));
    if (names.length > 1) break;
  }
  if (found.length === 0) return { error: "no .at file in the current directory or .claude/topologies/. Pass the file: agentopology visualize <file.at>" };
  return { error: `more than one .at file (${found.join(", ")}). Pass the one to draw: agentopology visualize <file.at>` };
}

export interface Opener { cmd: string; args: string[] }

/** The command that opens a file in the default browser. WSL is detected from the environment or /proc/version. */
export function openerFor(platform: string, env: Record<string, string | undefined>, procVersion: string): Opener {
  if (platform === "darwin") return { cmd: "open", args: [] };
  if (platform === "win32") return { cmd: "cmd", args: ["/c", "start", '""'] };
  if (env.WSL_DISTRO_NAME || env.WSL_INTEROP || /microsoft/i.test(procVersion)) return { cmd: "wslview", args: [] };
  return { cmd: "xdg-open", args: [] };
}

export function currentOpener(): Opener {
  let proc = "";
  if (process.platform === "linux") { try { proc = fs.readFileSync("/proc/version", "utf8"); } catch { /* not linux proc */ } }
  return openerFor(process.platform, process.env, proc);
}

/** Node counts and facts, for `--print-summary`. */
export function summaryLines(ast: TopologyAST, facts: Facts): string[] {
  const kinds = new Map<string, number>();
  for (const n of ast.nodes) kinds.set(n.type, (kinds.get(n.type) ?? 0) + 1);
  const lines = [
    `topology: ${ast.topology.name}`,
    `nodes: ${ast.nodes.length} (${[...kinds].map(([k, n]) => `${k} ${n}`).join(", ")})`,
    `edges: ${ast.edges.length}`,
    `facts: ${facts.checked ? "checked" : "not checked"}`,
    `source sha256: ${facts.sha256}`,
    `read at: ${facts.at}`,
  ];
  if (facts.validate === "not checked") lines.push("validate: not checked");
  else lines.push(`validate: ${facts.validate.errors} error(s), ${facts.validate.warnings} warning(s)`);
  if (facts.guard === "not checked") lines.push("guard: not checked");
  else {
    const by = new Map<string, number>();
    for (const g of Object.values(facts.guard)) by.set(g.strength, (by.get(g.strength) ?? 0) + 1);
    // D-6: a refuse count says how many rest on a ledger the agent can write (F-4).
    const ledger = Object.values(facts.guard).filter((g) => g.strength === "refuse" && g.gradeNote === LEDGER_WRITABLE_NOTE).length;
    const word = (k: string, n: number) => `${k} ${n}${k === "refuse" && ledger ? ` (${ledger} with an agent-writable ledger)` : ""}`;
    lines.push(`guard: ${by.size ? [...by].map(([k, n]) => word(k, n)).join(", ") : "no items"}`);
  }
  if (facts.inventory === "not checked") lines.push("inventory: not checked");
  else lines.push(`inventory: ${facts.inventory.mapped} of ${facts.inventory.total} mapped, ${facts.inventory.missing.length} missing`);
  lines.push(facts.version.mark ? `Claude Code: ${facts.version.mark}` : `Claude Code: ${facts.version.verifiedOn} (verified)`);
  return lines;
}

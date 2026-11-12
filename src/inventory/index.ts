/**
 * What is live in a project, and how much of it the .at accounts for.
 *
 * `collectInventory` lists live things under a project root: every file in the
 * .claude tree, each settings.json hook handler, each .mcp.json server and each
 * package.json script. It only reads.
 *
 * `coverage` matches them to a topology both ways. A live thing is mapped when
 * scaffold would write it from this .at, or when the .at points at it by hand
 * (file:, a hook's or gate's run, a tool's script, at:, an mcp server, a skill
 * folder it declares). A path the .at points at by hand that is not on disk is
 * missing. Things tagged "e" (the platform, the machine) are counted apart.
 *
 * validate never reads the project; this is what `validate --inventory` adds
 * on top of it.
 *
 * @module
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import type { TopologyAST } from "../parser/ast.js";
import { claudeCodeBinding } from "../bindings/claude-code.js";
import { runParts, isProjectPath } from "../parser/run.js";
import { matcherGaps, type MatcherGap } from "../conformance/claude-code.js";
import { sessionAgentsOf } from "../bindings/lib/session.js";

export { matcherGaps, type MatcherGap };

/** h: the harness itself · instrument: what measures it · e: the environment (never required). */
export type InventoryTag = "h" | "instrument" | "e";

export interface InventoryItem {
  /** Stable id, `<kind>:<name>`. */
  id: string;
  kind: "launchd" | "cron" | "agent" | "skill" | "skill-file" | "skill-dir" | "command" | "rule" | "config" | "claude-file" | "hook" | "mcp-server" | "mcp-tool" | "script";
  /** Project-relative file, for things that are files. */
  path?: string;
  /** sha256 of the file's bytes. */
  fingerprint?: string;
  /** Suggested by the collector, settled by the owner in a committed inventory.json. */
  tag?: InventoryTag;
}

export interface Inventory {
  version: 1;
  items: InventoryItem[];
}

const sha256 = (file: string) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");

function readJson(file: string): Record<string, any> | null {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
}

/** Folders that are never the harness: dependencies, VCS, Claude Code's own agent worktrees. */
const SKIP = new Set(["node_modules", ".git", "worktrees", "__pycache__", ".pytest_cache", ".benchmarks"]);
/** A skill's own files: its top level, its scripts and its references. Any other subfolder is its working space. */
const SKILL_PARTS = new Set(["scripts", "references"]);

/**
 * Files under .claude, and the working folders of skills listed as one entry
 * each (a video skill's renders are thousands of files that are output, not
 * harness). Measured on a real project: 75k files and 3.3 GB under .claude,
 * most of it worktrees, node_modules and skill workspaces.
 */
function walk(dir: string, rel: string[] = []): { files: string[]; dirs: string[] } {
  const out = { files: [] as string[], dirs: [] as string[] };
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (SKIP.has(e.name) && !(rel.length === 1 && rel[0] === "skills")) continue;
      const inSkill = rel.length === 2 && rel[0] === "skills";
      if (inSkill && !SKILL_PARTS.has(e.name)) { out.dirs.push(full); continue; }
      const sub = walk(full, [...rel, e.name]);
      out.files.push(...sub.files);
      out.dirs.push(...sub.dirs);
    } else if (e.isFile()) out.files.push(full);
  }
  return out;
}

/** What a file under .claude is, from where it sits. */
function classify(rel: string): Pick<InventoryItem, "id" | "kind" | "tag"> {
  const p = rel.split("/");
  if (p[1] === "agents") {
    const name = p.length === 3 ? p[2].replace(/\.md$/, "") : p[2];
    if (p.length === 3 || (p.length === 4 && p[3] === "AGENT.md")) return { id: `agent:${name}`, kind: "agent" };
  }
  if (p[1] === "skills" && p.length >= 4) {
    if (p.length === 4 && p[3] === "SKILL.md") return { id: `skill:${p[2]}`, kind: "skill" };
    return { id: `skill-file:${p.slice(2).join("/")}`, kind: "skill-file" };
  }
  if (p[1] === "commands") return { id: `command:${p.slice(2).join("/").replace(/\.md$/, "")}`, kind: "command" };
  if (p[1] === "rules") return { id: `rule:${p.slice(2).join("/").replace(/\.md$/, "")}`, kind: "rule" };
  if (p.length === 2 && p[1] === "settings.local.json") return { id: `config:${p[1]}`, kind: "config", tag: "e" };
  if (p.length === 2 && /\.json$/.test(p[1])) return { id: `config:${p[1]}`, kind: "config" };
  return { id: `claude-file:${p.slice(1).join("/")}`, kind: "claude-file" };
}

/** A hook handler's identity: event, matcher, and what it runs. */
function hookId(event: string, matcher: string | undefined, h: Record<string, any>): string {
  const what = h.command ?? h.url ?? (h.server ? `${h.server}/${h.tool}` : `${h.type}: ${String(h.prompt ?? "").slice(0, 40)}`);
  return `hook:${event}${matcher ? `[${matcher}]` : ""} ${what}`;
}

export interface CollectOptions {
  /** Folder of launchd plists; default `~/Library/LaunchAgents`. */
  launchAgentsDir?: string;
  /** The crontab text; default the output of `crontab -l`. */
  crontab?: string;
}

/** launchd plists and crontab lines whose command points into the project dir. Tagged e: the machine's, not the harness's. */
function scheduled(root: string, opts: CollectOptions): InventoryItem[] {
  const items: InventoryItem[] = [];
  const dir = opts.launchAgentsDir ?? path.join(process.env.HOME ?? "", "Library", "LaunchAgents");
  try {
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith(".plist")) continue;
      let text: string;
      try { text = fs.readFileSync(path.join(dir, name), "utf8"); } catch { continue; }
      if (!text.includes(root)) continue;
      const label = text.match(/<key>Label<\/key>\s*<string>([^<]*)<\/string>/)?.[1] ?? name.replace(/\.plist$/, "");
      items.push({ id: `launchd:${label}`, kind: "launchd", path: path.join(dir, name), tag: "e" });
    }
  } catch { /* no such folder: nothing to list */ }
  let tab = opts.crontab;
  if (tab === undefined) {
    try { tab = spawnSync("crontab", ["-l"], { encoding: "utf8", timeout: 3000 }).stdout ?? ""; } catch { tab = ""; }
  }
  for (const line of tab.split("\n")) {
    const t = line.trim();
    if (t && !t.startsWith("#") && t.includes(root)) items.push({ id: `cron:${t}`, kind: "cron", tag: "e" });
  }
  return items;
}

/** List every live thing under `root`, sorted by id. Reads only. */
export function collectInventory(root: string, opts: CollectOptions = {}): InventoryItem[] {
  const items: InventoryItem[] = [...scheduled(path.resolve(root), opts)];
  const tree = walk(path.join(root, ".claude"));
  const relOf = (full: string) => path.relative(root, full).split(path.sep).join("/");
  for (const full of tree.files) {
    const rel = relOf(full);
    items.push({ ...classify(rel), path: rel, fingerprint: sha256(full) });
  }
  for (const full of tree.dirs) {
    const rel = relOf(full);
    items.push({ id: `skill-dir:${rel.split("/").slice(2).join("/")}`, kind: "skill-dir", path: rel });
  }
  for (const name of ["settings.json", "settings.local.json"]) {
    const s = readJson(path.join(root, ".claude", name));
    for (const [event, entries] of Object.entries(s?.hooks ?? {})) {
      if (!Array.isArray(entries)) continue;
      for (const entry of entries as Array<Record<string, any>>) {
        for (const h of (entry.hooks ?? []) as Array<Record<string, any>>) {
          items.push({ id: hookId(event, entry.matcher, h), kind: "hook", path: `.claude/${name}`, ...(name === "settings.local.json" ? { tag: "e" as const } : {}) });
        }
      }
    }
  }
  const mcp = readJson(path.join(root, ".mcp.json"));
  for (const server of Object.keys(mcp?.mcpServers ?? {})) items.push({ id: `mcp:${server}`, kind: "mcp-server", path: ".mcp.json" });
  const pkg = readJson(path.join(root, "package.json"));
  for (const script of Object.keys(pkg?.scripts ?? {})) items.push({ id: `script:${script}`, kind: "script", path: "package.json" });

  const seen = new Set<string>();
  return items
    .filter((i) => (seen.has(i.id) ? false : (seen.add(i.id), true)))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

export interface MissingPointer {
  /** The project-relative path the .at points at. */
  path: string;
  /** What in the .at points at it. */
  from: string;
}

export interface CoverageReport {
  /** Live things that count (everything not tagged e). */
  total: number;
  mapped: number;
  unmapped: InventoryItem[];
  /** Tagged e: listed, never required. */
  external: InventoryItem[];
  /** Paths the .at points at by hand that are not on disk (an error). */
  missing: MissingPointer[];
  /** Files scaffold would write that are not on disk: scaffold has not been run since. */
  notScaffolded: string[];
  /** Tools a refuse hook leaves open on a server it guards, counting the inventory's tool names. */
  gaps: MatcherGap[];
}

const norm = (p: string) => p.replace(/^\.\//, "").replace(/^\$\{?CLAUDE_PROJECT_DIR\}?\//, "");
const citedPath = (at: string) => norm(at.replace(/:\d+$/, ""));

/** Paths the .at names by hand, each with what names it. */
function pointers(ast: TopologyAST): MissingPointer[] {
  const out: MissingPointer[] = [];
  const add = (p: string | undefined, from: string) => { if (p) out.push({ path: norm(p), from }); };
  const run = (r: string | undefined, from: string) => {
    if (!r) return;
    const { script } = runParts(r);
    if (script && isProjectPath(script) && !script.startsWith("/") && !script.startsWith("~")) add(script, from);
  };
  for (const n of ast.nodes) {
    add(n.file, `${n.type} ${n.id} file:`);
    if (n.type === "gate") {
      run(n.run, `gate ${n.id} run:`);
      if (n.at) add(citedPath(n.at), `gate ${n.id} at:`);
    }
    if (n.type === "agent") for (const h of n.hooks ?? []) run(h.run, `agent ${n.id} hook ${h.name} run:`);
  }
  for (const h of ast.hooks ?? []) if (!h.type || h.type === "command") run(h.run, `hook ${h.name} run:`);
  for (const s of ast.skills ?? []) add(s.file, `skill ${s.id} file:`);
  for (const t of ast.triggers ?? []) add(t.file, `trigger ${t.name} file:`);
  for (const t of ast.toolDefs ?? []) if (isProjectPath(t.script)) add(t.script, `tool ${t.id} script:`);
  for (const e of ast.edges) if (e.at) add(citedPath(e.at), `edge ${e.from} -> ${e.to} at:`);
  return out;
}

/** The script words of every command-style run the .at declares, for matching hand-built hook entries. */
function runScripts(ast: TopologyAST): string[] {
  const runs = [...(ast.hooks ?? []), ...ast.nodes.flatMap((n) => (n.type === "agent" ? n.hooks ?? [] : []))]
    .filter((h) => !h.type || h.type === "command").map((h) => h.run);
  for (const n of ast.nodes) if (n.type === "gate" && n.run) runs.push(n.run);
  return runs.map((r) => norm(runParts(r).script)).filter((s) => s.includes("/") || s.includes("."));
}

/** Match live things to the .at, both ways. */
export function coverage(ast: TopologyAST, items: InventoryItem[], root: string): CoverageReport {
  const generated = claudeCodeBinding.scaffold(ast);
  const genPaths = new Set(generated.map((f) => norm(f.path)));
  const genHooks = new Set<string>();
  const genSettings = generated.find((f) => f.path === ".claude/settings.json");
  if (genSettings) {
    const s = JSON.parse(genSettings.content);
    for (const [event, entries] of Object.entries(s.hooks ?? {}))
      for (const entry of entries as Array<Record<string, any>>)
        for (const h of entry.hooks ?? []) genHooks.add(hookId(event, entry.matcher, h));
  }
  const genMcp = generated.find((f) => f.path === ".mcp.json");
  const servers = new Set([
    ...Object.keys(ast.mcpServers ?? {}),
    ...Object.keys(genMcp ? JSON.parse(genMcp.content).mcpServers ?? {} : {}),
    ...ast.nodes.flatMap((n) => (n.type === "agent" ? n.mcpServers ?? [] : [])),
  ]);
  const declared = pointers(ast);
  const handPaths = new Set(declared.map((d) => d.path));
  const skillDirs = new Set([
    ...(ast.skills ?? []).map((s) => s.id),
    ...[...genPaths].filter((p) => /^\.claude\/skills\/[^/]+\/SKILL\.md$/.test(p)).map((p) => p.split("/")[2]),
  ]);
  // A store's data lives under its path; the store is declared, its rows are not listed one by one.
  const storeDirs = (ast.stores ?? []).filter((st) => st.path).map((st) => norm(st.path!).replace(/\/?$/, "/"));
  const scripts = runScripts(ast);
  const hasSessions = sessionAgentsOf(ast).length > 0;
  const mentioned = [
    ...ast.nodes.flatMap((n) => (n.type === "action" ? n.commands ?? [] : [])),
    ...(ast.hooks ?? []).map((h) => h.run ?? ""),
  ].join("\n");

  const isMapped = (i: InventoryItem): boolean => {
    switch (i.kind) {
      case "hook": {
        if (genHooks.has(i.id)) return true;
        const command = i.id.slice(i.id.indexOf(" ") + 1);
        return scripts.some((s) => command.includes(s));
      }
      case "mcp-server": return servers.has(i.id.slice(4));
      // A tool is the server's, listed so matchers can be checked against it.
      case "mcp-tool": return servers.has(i.id.slice(9).split("__")[1] ?? "");
      case "script": return new RegExp(`\\b(?:npm run|pnpm|yarn|bun run) ${i.id.slice(7).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(mentioned);
      default: {
        const p = norm(i.path ?? "");
        // The generated talk guard appends to this log whenever session agents exist.
        if (p === ".claude/state/talk.jsonl" && hasSessions) return true;
        if (genPaths.has(p) || handPaths.has(p)) return true;
        if (storeDirs.some((d) => p.startsWith(d))) return true;
        const folder = p.match(/^\.claude\/skills\/([^/]+)\//)?.[1];
        return !!folder && skillDirs.has(folder);
      }
    }
  };

  const external = items.filter((i) => i.tag === "e");
  const counted = items.filter((i) => i.tag !== "e");
  const unmapped = counted.filter((i) => !isMapped(i));
  const seen = new Set<string>();
  const missing = declared
    .filter((d) => !fs.existsSync(path.join(root, d.path)))
    .filter((d) => (seen.has(d.path) ? false : (seen.add(d.path), true)));
  const notScaffolded = [...genPaths].filter((p) => !handPaths.has(p) && !fs.existsSync(path.join(root, p))).sort();
  const gaps = matcherGaps(ast as never, items.filter((i) => i.kind === "mcp-tool").map((i) => i.id.slice(9)));
  return { total: counted.length, mapped: counted.length - unmapped.length, unmapped, external, missing, notScaffolded, gaps };
}

/** The coverage section validate prints. */
export function renderCoverage(r: CoverageReport): string[] {
  const pct = r.total ? Math.round((r.mapped / r.total) * 100) : 100;
  const lines = [`coverage: ${r.mapped} of ${r.total} live things are in the .at (${pct}%)`];
  if (r.unmapped.length) {
    lines.push(`  unmapped (${r.unmapped.length}), nothing in the .at accounts for these:`);
    for (const i of r.unmapped) lines.push(`    ${i.id}${i.path && !i.id.includes(i.path) ? `  (${i.path})` : ""}`);
  }
  if (r.missing.length) {
    lines.push(`  missing (${r.missing.length}), the .at points at these and they are not on disk:`);
    for (const m of r.missing) lines.push(`    ${m.path}  ← ${m.from}`);
  }
  if (r.gaps.length) {
    lines.push(`  matcher gaps (${r.gaps.length}), a refuse hook guards the server but not this tool:`);
    for (const g of r.gaps) lines.push(`    ${g.tool}  ← hook ${g.hook}`);
  }
  if (r.external.length) lines.push(`  external (${r.external.length}), tagged e, not required: ${r.external.map((i) => i.id).join(", ")}`);
  if (r.notScaffolded.length) lines.push(`  not scaffolded (${r.notScaffolded.length}): scaffold would write these and they are not on disk; rerun scaffold`);
  return lines;
}

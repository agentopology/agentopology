/**
 * `agentopology guard <file> --target claude-code`: write the guard part of
 * what scaffold writes, and nothing else, into a project that may have been
 * built by hand.
 *
 * Why it exists: scaffold owns a whole project; a hand-built one has its own
 * agents, skills and settings, and only lacks the hooks that refuse. Running
 * scaffold there meant either every generated file next to the user's or none.
 * This writes the enforcement and leaves the rest.
 *
 * The set is discovered, not listed: the scripts settings.json hook commands
 * run, then every generated file those scripts name by `$CLAUDE_PROJECT_DIR/…`
 * (the gate wrappers, then the check scripts the gates run). A hard-coded
 * list went stale the first time the binding added a hook script.
 *
 * @module
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { TopologyAST } from "../parser/ast.js";
import { claudeCodeBinding } from "../bindings/claude-code.js";
import type { GeneratedFile } from "../bindings/types.js";
import { isStubContent } from "../bindings/lib/stub.js";
import { readManifest, writeManifest, hashContent } from "../scaffold/manifest.js";
import { computeIncrementalPlan, executeActions, nextManifestFiles, type ExecuteResult } from "../scaffold/incremental.js";
import type { FileAction, ScaffoldManifest } from "../scaffold/types.js";

const SETTINGS = ".claude/settings.json";
const VAR_PATH = /\$\{?([A-Za-z_]\w*)\}?\/([^\s"'`;|&)]+)/g;

/**
 * The generated paths a piece of text names: `$CLAUDE_PROJECT_DIR/<path>`, or
 * `$VAR/<file>` where the text sets `VAR="<dir>"` itself. before-agent.sh calls
 * its gates as `"$DIR/gate-x.sh"` with `DIR=".claude/skills/…/scripts"`; reading
 * only the project-dir form missed every gate (the first run of N41).
 */
function refs(text: string, known: Set<string>): string[] {
  const vars = new Map<string, string>([["CLAUDE_PROJECT_DIR", ""]]);
  for (const m of text.matchAll(/^\s*(?:export\s+)?([A-Za-z_]\w*)=["']?([^"'\n]*?)["']?\s*$/gm)) vars.set(m[1], m[2].replace(/^\.\//, "").replace(/\/$/, ""));
  const out: string[] = [];
  for (const m of text.matchAll(VAR_PATH)) {
    const dir = vars.get(m[1]);
    if (dir === undefined) continue;
    const p = (dir ? `${dir}/` : "") + m[2].replace(/^\.\//, "");
    if (known.has(p)) out.push(p);
  }
  return out;
}

/** `hooks` keeps only command groups (a prompt or http hook names no script and could not be told apart on a rerun); `permissions` whole. */
function guardSettings(raw: string): string {
  const s = JSON.parse(raw) as { hooks?: Record<string, Array<{ hooks?: Array<{ type?: string; command?: string }> }>>; permissions?: unknown };
  const hooks: Record<string, unknown[]> = {};
  for (const [event, groups] of Object.entries(s.hooks ?? {})) {
    const kept = groups
      .map((g) => ({ ...g, hooks: (g.hooks ?? []).filter((h) => typeof h.command === "string") }))
      .filter((g) => g.hooks.length > 0);
    if (kept.length > 0) hooks[event] = kept;
  }
  const out: Record<string, unknown> = {};
  if (Object.keys(hooks).length > 0) out.hooks = hooks;
  if (s.permissions !== undefined) out.permissions = s.permissions;
  return JSON.stringify(out, null, 2) + "\n";
}

/** The guard subset of a binding's output: hook scripts, gates, checks, and settings.json cut to hooks and permissions. */
export function guardFiles(files: GeneratedFile[]): GeneratedFile[] {
  return discover(files).files;
}

/** `checks` are the files two calls from a hook (the checks the gates run), for the "no longer a stub" rule. */
function discover(files: GeneratedFile[]): { files: GeneratedFile[]; checks: Set<string> } {
  const byPath = new Map(files.map((f) => [f.path, f]));
  const known = new Set(byPath.keys());
  const settings = byPath.get(SETTINGS);
  const picked = new Map<string, GeneratedFile>();
  const checks = new Set<string>();
  const queue: string[] = [];
  if (settings) {
    const hooks = (JSON.parse(settings.content) as { hooks?: Record<string, Array<{ hooks?: Array<{ command?: string }> }>> }).hooks ?? {};
    for (const groups of Object.values(hooks))
      for (const g of groups) for (const h of g.hooks ?? []) if (h.command) queue.push(...refs(h.command, known));
  }
  // depth 0: scripts hooks run; 1: gate wrappers they call; 2+: the checks the gates run
  const depth = new Map<string, number>(queue.map((p) => [p, 0]));
  while (queue.length > 0) {
    const p = queue.shift()!;
    if (picked.has(p)) continue;
    const f = byPath.get(p)!;
    picked.set(p, f);
    for (const r of refs(f.content, known)) {
      if (r === p) continue;
      if (!depth.has(r)) depth.set(r, depth.get(p)! + 1);
      queue.push(r);
    }
  }
  for (const [p, d] of depth) if (d >= 2) checks.add(p);
  const out = [...picked.values()];
  if (settings) out.push({ ...settings, content: guardSettings(settings.content) });
  return { files: out, checks };
}

export interface GuardTargetPlan {
  /** What would be written, per file. */
  actions: FileAction[];
  /** Files left as they are, and why. */
  skipped: Array<{ path: string; why: string }>;
  /** The files this run owns (the subset of scaffold's output). */
  files: GeneratedFile[];
  /** Check scripts, reached through a gate, among `files`. */
  checks: Set<string>;
}

/** Plan the guard write for a project. Reads the disk; writes nothing. */
export function planGuardTarget(ast: TopologyAST, root: string, source: string): GuardTargetPlan {
  const { files, checks } = discover(claudeCodeBinding.scaffold(ast));
  const manifest = readManifest(root, "claude-code", source);
  const owned = new Set(files.map((f) => f.path));
  // The planner deletes manifest files the run no longer generates; this run
  // generates a subset on purpose, so only its own paths are planned.
  const actions = computeIncrementalPlan(root, "claude-code", files, manifest).filter((a) => owned.has(a.path));
  const skipped: GuardTargetPlan["skipped"] = [];
  const planned: FileAction[] = [];
  for (const a of actions) {
    const abs = join(root, a.path);
    const generated = files.find((f) => f.path === a.path)!;
    // A check someone has implemented is theirs, even when scaffold recorded
    // its stub: the hash then differs from the manifest only by their work.
    if (checks.has(a.path) && existsSync(abs) && a.type !== "unchanged") {
      const onDisk = readFileSync(abs, "utf-8");
      if (onDisk !== generated.content && !isStubContent(onDisk)) {
        skipped.push({ path: a.path, why: "skipped: no longer a stub" });
        continue;
      }
    }
    if (a.type === "conflict") { skipped.push({ path: a.path, why: `kept: ${a.detail}` }); continue; }
    if (a.type === "kept") { skipped.push({ path: a.path, why: `kept: ${a.detail}` }); continue; }
    if (a.type === "blocked" && !a.unsafe) { skipped.push({ path: a.path, why: `blocked: ${a.detail}` }); continue; }
    planned.push(a);
  }
  return { actions: planned, skipped, files, checks };
}

/**
 * Write a plan and record it in the scaffold manifest. The manifest keeps the
 * entries of files this run did not touch (a full scaffold's agents, say), so
 * a later scaffold still knows what it owns. Nothing is pruned.
 */
export function applyGuardTarget(plan: GuardTargetPlan, root: string, source: string, sourceText: string): ExecuteResult {
  const previous = readManifest(root, "claude-code", source);
  const result = executeActions(root, plan.actions, { prune: false, force: false });
  const manifest: ScaffoldManifest = {
    source,
    sourceHash: hashContent(sourceText),
    target: "claude-code",
    generatedAt: new Date().toISOString(),
    files: { ...(previous?.files ?? {}), ...nextManifestFiles(root, plan.actions, plan.files, previous, result) },
  };
  // A timestamp alone is not a change: a rerun that did nothing writes nothing.
  const same = previous && previous.sourceHash === manifest.sourceHash && JSON.stringify(previous.files) === JSON.stringify(manifest.files);
  if (!same) writeManifest(root, "claude-code", manifest);
  return result;
}

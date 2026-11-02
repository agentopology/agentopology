/**
 * Reading a project for import or sync.
 *
 * Import used to read every file under --dir except node_modules and .git. On
 * a large repo that meant every worktree and build folder: over two minutes,
 * and any `agents/x.md` in the source tree became an agent. A folder name
 * alone cannot decide: `.claude/skills/build/` is a real skill. So the
 * generated-folder list applies outside the platform's own folders only.
 *
 * @module
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { PlatformFile } from "../sync/index.js";

/** Never holds anything a project's agent setup is made of. */
const NEVER_READ = new Set(["node_modules", ".git"]);

/** Generated or checked-out copies of the repo; skipped outside platform folders. */
export const GENERATED_FOLDERS = new Set([
  ".worktrees", "worktrees", "dist", "build", "out", "coverage", ".next", ".nuxt", ".turbo",
  ".cache", ".venv", "venv", "__pycache__", "target", ".pytest_cache", ".mypy_cache",
]);

/** Folders whose children are named by the author (a skill may be called `build`). */
const NAMED_BY_AUTHOR = new Set(["agents", "skills", "commands"]);

/** What a walk saw, without reading any file. */
interface Entry {
  rel: string;
  full: string;
}

/**
 * Every file under `root`, following symlinked folders (a skill linked from
 * another repo) once each, so a link cycle ends. `skip` decides each folder.
 */
function walkFiles(root: string, prefix: string, skip: (name: string, parent: string, rel: string) => boolean): Entry[] {
  const out: Entry[] = [];
  const seen = new Set<string>();
  const walk = (dir: string, rel: string) => {
    const real = fs.realpathSync(dir);
    if (seen.has(real)) return;
    seen.add(real);
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const childRel = path.join(rel, entry.name);
      const full = path.join(dir, entry.name);
      const isDir = entry.isDirectory() || (entry.isSymbolicLink() && fs.statSync(full, { throwIfNoEntry: false })?.isDirectory());
      if (isDir) {
        if (!skip(entry.name, path.basename(dir), childRel)) walk(full, childRel);
      } else if (entry.isFile() || entry.isSymbolicLink()) {
        out.push({ rel: childRel, full });
      }
    }
  };
  walk(root, prefix);
  return out;
}

const read = (e: Entry): PlatformFile => ({ path: e.rel, content: fs.readFileSync(e.full, "utf-8") });

/**
 * Every file under `dir` that is not generated. Paths are project-relative
 * (what `file:` records), so a walk started at the .claude folder itself keeps
 * that prefix.
 */
export function readProject(dir: string): PlatformFile[] {
  const prefix = path.basename(dir) === ".claude" ? ".claude" : "";
  const skip = (name: string, parent: string, rel: string) =>
    NEVER_READ.has(name) ||
    (GENERATED_FOLDERS.has(name) && !NAMED_BY_AUTHOR.has(parent) && !insideClaude(rel, name));
  return walkFiles(dir, prefix, skip).map(read);
}

/** Inside .claude every folder is the author's, except Claude Code's own worktrees. */
function insideClaude(rel: string, name: string): boolean {
  return rel.split(path.sep).includes(".claude") && !(name === "worktrees" && rel === path.join(".claude", "worktrees"));
}

/** What a Claude Code import reads from a project, and what it left out. */
export interface ClaudeProject {
  files: PlatformFile[];
  /** .claude folders below the root: not this project's session config. */
  nestedConfigs: string[];
}

/**
 * Only what a Claude Code import uses: the root .claude folder's Markdown,
 * JSON and shell files, .mcp.json, and every .at file in the project (a flow
 * source). The rest of the tree is walked by name and never read. Null when
 * `dir` has no .claude folder: it is then a config folder given directly.
 */
export function readClaudeProject(dir: string): ClaudeProject | null {
  const config = path.join(dir, ".claude");
  const atConfig = path.basename(dir) === ".claude";
  if (!atConfig && !fs.statSync(config, { throwIfNoEntry: false })?.isDirectory()) return null;

  const nestedConfigs: string[] = [];
  const skip = (name: string, parent: string, rel: string) => {
    if (NEVER_READ.has(name)) return true;
    const top = rel === ".claude" || rel.startsWith(`.claude${path.sep}`);
    if (top || atConfig) return rel === path.join(".claude", "worktrees");
    if (GENERATED_FOLDERS.has(name)) return true;
    if (name === ".claude") {
      nestedConfigs.push(rel);
      return true;
    }
    return false;
  };

  const wanted = (rel: string) => {
    if (rel.endsWith(".at")) return true;
    if (rel === ".mcp.json") return true;
    return rel.startsWith(`.claude${path.sep}`) && /\.(?:md|json|sh)$/.test(rel);
  };
  const entries = walkFiles(dir, atConfig ? ".claude" : "", skip).filter((e) => wanted(e.rel));
  return { files: entries.map(read), nestedConfigs };
}

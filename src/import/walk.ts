/**
 * Reading a project for import or sync.
 *
 * Import used to read every file under --dir except node_modules and .git. On
 * a large repo that meant every worktree and build folder: over two minutes,
 * and any `agents/x.md` in the source tree became an agent. A folder name
 * alone cannot decide: `.claude/skills/build/` is a real skill. So the
 * generated-folder list applies outside the platform's own folders only.
 *
 * A read must also end, and say why if it cannot finish. On that repo 0.8.0
 * tried to hold 1,061,701 files (16.4 GB) as strings, ran 656 seconds and was
 * terminated with no output and no .at. So a file that is too big or unreadable
 * is skipped and named, and past a total budget the read stops with a message.
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

/** Larger than any agent, skill or settings file; a log or a media file. */
export const MAX_FILE_BYTES = 5 * 1024 * 1024;
/** What one read may hold in memory. */
export const MAX_TOTAL_BYTES = 256 * 1024 * 1024;

/** A file or folder the walk could not use, and why. */
export interface Unread {
  path: string;
  reason: string;
}

/** What a walk saw, without reading any file. */
interface Entry {
  rel: string;
  full: string;
}

/**
 * Every file under `root`. `follow` decides which symlinked folders are entered
 * (each real folder once, so a link cycle ends); `skip` decides each folder. A
 * folder that cannot be listed or a broken link is recorded, not fatal.
 */
function walkFiles(
  root: string,
  prefix: string,
  skip: (name: string, parent: string, rel: string) => boolean,
  follow: (rel: string) => boolean,
  unread: Unread[],
): Entry[] {
  const out: Entry[] = [];
  const seen = new Set<string>();
  const walk = (dir: string, rel: string) => {
    let entries: fs.Dirent[];
    try {
      const real = fs.realpathSync(dir);
      if (seen.has(real)) return;
      seen.add(real);
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      unread.push({ path: rel || ".", reason: (err as Error).message.split(":")[0] });
      return;
    }
    for (const entry of entries) {
      const childRel = path.join(rel, entry.name);
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!skip(entry.name, path.basename(dir), childRel)) walk(full, childRel);
      } else if (entry.isSymbolicLink()) {
        const target = fs.statSync(full, { throwIfNoEntry: false });
        if (target?.isDirectory()) {
          if (follow(childRel) && !skip(entry.name, path.basename(dir), childRel)) walk(full, childRel);
        } else if (target?.isFile()) {
          out.push({ rel: childRel, full });
        }
        // A broken link, or a link to a socket or a pipe: nothing to read.
      } else if (entry.isFile()) {
        out.push({ rel: childRel, full });
      }
    }
  };
  walk(root, prefix);
  return out;
}

/** Read the walked files within the limits; refuse past the total budget. */
function readEntries(entries: Entry[], unread: Unread[]): PlatformFile[] {
  const files: PlatformFile[] = [];
  let total = 0;
  for (const e of entries) {
    try {
      const size = fs.statSync(e.full).size;
      if (size > MAX_FILE_BYTES) {
        unread.push({ path: e.rel, reason: `${Math.round(size / 1048576)} MB, over the ${MAX_FILE_BYTES / 1048576} MB limit` });
        continue;
      }
      total += size;
      if (total > MAX_TOTAL_BYTES) {
        throw new ReadBudgetError(
          `Stopped reading after ${MAX_TOTAL_BYTES / 1048576} MB (${files.length} files, at ${e.rel}). ` +
            `This is more than an agent setup: point --dir at the project root or its .claude folder.`,
        );
      }
      files.push({ path: e.rel, content: fs.readFileSync(e.full, "utf-8") });
    } catch (err) {
      if (err instanceof ReadBudgetError) throw err;
      unread.push({ path: e.rel, reason: (err as Error).message.split(":")[0] });
    }
  }
  return files;
}

/** The read would not fit; the CLI prints this and exits non-zero. */
export class ReadBudgetError extends Error {}

/** What a read returned, and what it could not use. */
export interface ProjectRead {
  files: PlatformFile[];
  unread: Unread[];
}

/**
 * Every file under `dir` that is not generated. Paths are project-relative
 * (what `file:` records), so a walk started at the .claude folder itself keeps
 * that prefix.
 */
export function readProject(dir: string): ProjectRead {
  const prefix = path.basename(dir) === ".claude" ? ".claude" : "";
  const skip = (name: string, parent: string, rel: string) =>
    NEVER_READ.has(name) ||
    (GENERATED_FOLDERS.has(name) && !NAMED_BY_AUTHOR.has(parent) && !insideClaude(rel, name));
  const unread: Unread[] = [];
  const entries = walkFiles(dir, prefix, skip, () => true, unread);
  return { files: readEntries(entries, unread), unread };
}

/** Inside .claude every folder is the author's, except Claude Code's own worktrees. */
function insideClaude(rel: string, name: string): boolean {
  return rel.split(path.sep).includes(".claude") && !(name === "worktrees" && rel === path.join(".claude", "worktrees"));
}

/** What a Claude Code import reads from a project, and what it left out. */
export interface ClaudeProject extends ProjectRead {
  /** .claude folders below the root: not this project's session config. */
  nestedConfigs: string[];
}

/**
 * Only what a Claude Code import uses: the root .claude folder's Markdown,
 * JSON and shell files, .mcp.json, and every .at file in the project (a flow
 * source). The rest of the tree is walked by name and never read, and a link
 * outside .claude is not followed: it can lead anywhere on the disk. Null when
 * `dir` has no .claude folder: it is then a config folder given directly.
 */
export function readClaudeProject(dir: string): ClaudeProject | null {
  const config = path.join(dir, ".claude");
  const atConfig = path.basename(dir) === ".claude";
  if (!atConfig && !fs.statSync(config, { throwIfNoEntry: false })?.isDirectory()) return null;

  const nestedConfigs: string[] = [];
  const inConfig = (rel: string) => rel === ".claude" || rel.startsWith(`.claude${path.sep}`);
  const skip = (name: string, parent: string, rel: string) => {
    if (NEVER_READ.has(name)) return true;
    if (inConfig(rel)) return rel === path.join(".claude", "worktrees");
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
    return inConfig(rel) && /\.(?:md|json|sh)$/.test(rel);
  };
  const unread: Unread[] = [];
  const entries = walkFiles(dir, atConfig ? ".claude" : "", skip, inConfig, unread).filter((e) => wanted(e.rel));
  return { files: readEntries(entries, unread), unread, nestedConfigs };
}

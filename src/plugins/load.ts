/**
 * Loading plugin modules for the CLI (EXPERIMENTAL: may change before 1.0).
 *
 * A plugin is code that runs with the user's rights at compile time, so it is
 * loaded only from what the user typed or wrote in their own package.json:
 * the repeatable `--plugin <module>` flag, and `"agentopology": { "plugins":
 * [...] }` in the project folder's package.json. An .at file never loads code.
 * An explicit path (`./`, `../` or absolute) loads that one file, wherever it
 * is (a bundled single-file plugin needs no package.json). A bare name is a
 * package resolved from the project folder; one that resolves outside
 * node_modules and the project is refused. Every load is printed.
 *
 * @module
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import type { AtPlugin } from "./types.js";
import { PluginError, checkPlugin } from "./runtime.js";

/** One module to load: the specifier as written, and the folder a relative one is read from. */
export interface PluginRequest {
  spec: string;
  base: string;
  /** Where it was written, for messages ("--plugin", "package.json"). */
  from: string;
}

export interface LoadedPlugin {
  plugin: AtPlugin;
  version: string;
  path: string;
}

/** The `agentopology.plugins` list of `<projectDir>/package.json`, as requests; none when there is no such list. */
export function packagePluginRequests(projectDir: string): PluginRequest[] {
  const file = path.join(projectDir, "package.json");
  if (!fs.existsSync(file)) return [];
  let pkg: { agentopology?: { plugins?: unknown } };
  try {
    pkg = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return []; // not ours to judge; npm reports a broken package.json
  }
  const list = pkg?.agentopology?.plugins;
  if (list === undefined) return [];
  if (!Array.isArray(list) || !list.every((s) => typeof s === "string")) {
    throw new PluginError(`${file}: "agentopology": { "plugins" } must be a list of module names or paths.`);
  }
  return list.map((spec) => ({ spec, base: projectDir, from: file }));
}

/** An explicit path: `./`, `../`, or absolute (`/…`, or a drive path on Windows). Loaded from where it is, even outside the project. */
const explicit = (spec: string) => spec.startsWith("./") || spec.startsWith("../") || path.isAbsolute(spec) || /^[A-Za-z]:[\\/]/.test(spec);

const inside = (file: string, dir: string) => {
  const rel = path.relative(dir, file);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
};

/** A bare package name: Node's resolution from the project folder, then its package.json `exports`/`main` (an ESM-only package). */
function resolveBare(spec: string, projectDir: string): string | null {
  try {
    return createRequire(path.join(projectDir, "package.json")).resolve(spec);
  } catch {
    // fall through: an ESM-only "exports" has no require condition
  }
  const parts = spec.split("/");
  const name = spec.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
  const sub = parts.slice(spec.startsWith("@") ? 2 : 1).join("/");
  for (let dir = projectDir; ; dir = path.dirname(dir)) {
    const pkgDir = path.join(dir, "node_modules", name);
    const pkgFile = path.join(pkgDir, "package.json");
    if (fs.existsSync(pkgFile)) {
      const pkg = JSON.parse(fs.readFileSync(pkgFile, "utf8")) as { exports?: unknown; module?: string; main?: string };
      const key = sub ? `./${sub}` : ".";
      const exp = typeof pkg.exports === "string" && key === "." ? pkg.exports
        : (pkg.exports as Record<string, unknown> | undefined)?.[key] ?? (key === "." ? (pkg.exports as Record<string, unknown> | undefined) : undefined);
      const pick = (e: unknown): string | undefined =>
        typeof e === "string" ? e : e && typeof e === "object" ? pick((e as Record<string, unknown>).import ?? (e as Record<string, unknown>).default) : undefined;
      const target = pick(exp) ?? (sub || pkg.module || pkg.main || "index.js");
      return path.join(pkgDir, target);
    }
    if (path.dirname(dir) === dir) return null;
  }
}

/** Where a request resolves to on disk; throws when it cannot be found or is outside what may load. */
export function resolvePlugin(req: PluginRequest, projectDir: string): string {
  const { spec } = req;
  const file = explicit(spec) ? path.resolve(req.base, spec) : resolveBare(spec, projectDir);
  if (!file || !fs.existsSync(file)) throw new PluginError(`plugin ${spec} (${req.from}) was not found${file ? ` at ${file}` : ` from ${projectDir}`}.`);
  const real = fs.realpathSync(file);
  if (fs.statSync(real).isDirectory()) throw new PluginError(`plugin ${spec} (${req.from}) is a folder; name the module file.`);
  if (!explicit(spec)) {
    const project = fs.realpathSync(projectDir);
    if (!inside(real, project) && !real.split(path.sep).includes("node_modules")) {
      throw new PluginError(
        `plugin ${spec} (${req.from}) resolves to ${real}, outside node_modules and the project ${project}; refused. ` +
          `Write it as an explicit path (./, ../ or absolute) to load it.`,
      );
    }
  }
  return real;
}

/** Resolve, import and check each requested plugin, in order; one file requested twice loads once. */
export async function loadPlugins(requests: readonly PluginRequest[], projectDir: string): Promise<LoadedPlugin[]> {
  const out: LoadedPlugin[] = [];
  const seen = new Set<string>();
  for (const req of requests) {
    const file = resolvePlugin(req, projectDir);
    if (seen.has(file)) continue;
    seen.add(file);
    let mod: { default?: unknown; plugin?: unknown };
    try {
      mod = await import(pathToFileURL(file).href);
    } catch (err) {
      throw new PluginError(`plugin ${req.spec} (${file}) failed to load: ${(err as Error).message}`);
    }
    const plugin = checkPlugin(mod.default ?? mod.plugin, `plugin module ${req.spec} (${file})`);
    out.push({ plugin, version: typeof plugin.version === "string" && plugin.version ? plugin.version : "unversioned", path: file });
  }
  return out;
}

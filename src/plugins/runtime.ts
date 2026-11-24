/**
 * Where loaded plugins meet the compiler (EXPERIMENTAL: may change before 1.0).
 *
 * Every function here is a no-op when no plugin is loaded: the parse, the
 * validation and the scaffold of a topology are then exactly what they are
 * without this module. Plugins reach the compiler only through
 * {@link setActivePlugins} (the CLI calls it once, after loading the
 * `--plugin` modules) or through `parse(source, { plugins })`. An .at file
 * never loads code.
 *
 * What a parse read for its plugins is kept on the AST as `_plugins`, a
 * non-enumerable property (like `sourcePath`), so JSON export and goldens
 * never see it.
 *
 * @module
 */

import type { TopologyAST, GateNode } from "../parser/ast.js";
import { extractTopLevelBlocks, parseFields, unquote } from "../parser/lexer.js";
import { TOPOLOGY_BLOCKS } from "../parser/known-fields.js";
import type { AtPlugin, Diagnostic, PluginData, ReadonlyTopology } from "./types.js";

/** A plugin that breaks a rule of the seam. The CLI prints the message and exits 1. */
export class PluginError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PluginError";
  }
}

/** Top-level names a plugin may not take: every core section, and the topology's own fields and words. */
export const CORE_KEYWORDS: ReadonlySet<string> = new Set([
  ...TOPOLOGY_BLOCKS,
  "topology", "fragment", "import", "include", "prompt",
  "decisions", "pin-models", "uses-plugins",
]);

const KEYWORD = /^[A-Za-z][A-Za-z0-9_-]*$/;

/** Check one plugin's shape; throws a {@link PluginError} naming it. */
export function checkPlugin(p: unknown, where = "plugin"): AtPlugin {
  const plugin = p as Partial<AtPlugin> | null | undefined;
  if (!plugin || typeof plugin !== "object") throw new PluginError(`${where} does not export a plugin object (default export or \`plugin\`).`);
  if (typeof plugin.id !== "string" || !KEYWORD.test(plugin.id)) throw new PluginError(`${where}: the plugin id must be a word of letters, digits, _ and - (got ${JSON.stringify(plugin.id)}).`);
  const name = `plugin ${plugin.id}`;
  if (plugin.apiVersion !== 1) {
    throw new PluginError(`${name} is written for plugin API version ${JSON.stringify(plugin.apiVersion)}; this agentopology supports apiVersion 1 only.`);
  }
  if (!plugin.blocks || typeof plugin.blocks !== "object") throw new PluginError(`${name} has no \`blocks\` object.`);
  for (const [kw, block] of Object.entries(plugin.blocks)) {
    if (!KEYWORD.test(kw)) throw new PluginError(`${name}: block keyword ${JSON.stringify(kw)} is not a word.`);
    if (CORE_KEYWORDS.has(kw)) throw new PluginError(`${name}: block keyword "${kw}" is a core section of the language; a plugin cannot take it.`);
    if (!block || (block.multiplicity !== "single" && block.multiplicity !== "repeated")) {
      throw new PluginError(`${name}: block "${kw}" needs multiplicity "single" or "repeated".`);
    }
  }
  return plugin as AtPlugin;
}

/** Check a set of plugins: each one, and no id or keyword taken twice. */
export function checkPluginSet(plugins: readonly unknown[]): readonly AtPlugin[] {
  const ids = new Map<string, true>();
  const owner = new Map<string, string>();
  const out: AtPlugin[] = [];
  for (const p of plugins) {
    const plugin = checkPlugin(p);
    if (ids.has(plugin.id)) throw new PluginError(`plugin ${plugin.id} is loaded twice.`);
    ids.set(plugin.id, true);
    for (const kw of Object.keys(plugin.blocks)) {
      const other = owner.get(kw);
      if (other) throw new PluginError(`plugin ${plugin.id}: block keyword "${kw}" is already owned by plugin ${other}.`);
      owner.set(kw, plugin.id);
    }
    out.push(plugin);
  }
  return out;
}

let active: readonly AtPlugin[] = [];

/** The plugin set every parse uses when it is given none (imports and includes too). Set once by the CLI. */
export function setActivePlugins(plugins: readonly AtPlugin[]): void {
  active = checkPluginSet(plugins);
}

/** The plugin set a parse uses by default: empty unless the CLI loaded plugins. */
export function activePlugins(): readonly AtPlugin[] {
  return active;
}

/** What one parse read for its plugins. */
export interface PluginState {
  plugins: readonly AtPlugin[];
  /** Per plugin id: its blocks' data. */
  data: Record<string, PluginData>;
}

type WithPlugins = TopologyAST & { _plugins?: PluginState };

export function pluginStateOf(ast: TopologyAST): PluginState | undefined {
  return (ast as WithPlugins)._plugins;
}

/** Set a non-enumerable property (the `sourcePath` precedent). */
export function setHidden(obj: object, key: string, value: unknown): void {
  Object.defineProperty(obj, key, { value, enumerable: false, writable: true, configurable: true });
}

interface ParseFinding { rule: string; level: "error" | "warning"; message: string; node?: string; line?: number }

/**
 * Parse every loaded plugin's blocks from the topology body. `lineAt` maps an
 * offset in `topBody` to its source line. Returns the data, the V102 schema of
 * each plugin keyword, and V23 warnings for a `single` block written twice.
 */
export function parsePluginBlocks(
  topBody: string,
  plugins: readonly AtPlugin[],
  lineAt: (at: number) => number,
): { state: PluginState; schemas: Record<string, { fields: readonly string[] } | null>; warnings: ParseFinding[] } {
  const data: Record<string, PluginData> = {};
  const schemas: Record<string, { fields: readonly string[] } | null> = {};
  const warnings: ParseFinding[] = [];
  for (const plugin of plugins) {
    const own: PluginData = {};
    for (const [kw, spec] of Object.entries(plugin.blocks)) {
      schemas[kw] = spec.fields ? { fields: spec.fields } : null;
      const found = extractTopLevelBlocks(topBody, kw);
      if (spec.multiplicity === "single" && found.length > 1) {
        warnings.push({ rule: "V23", level: "warning", message: `Duplicate "${kw}" block detected (found ${found.length}) — only the first occurrence is used` });
      }
      const used = spec.multiplicity === "single" ? found.slice(0, 1) : found;
      own[kw] = used.map((b) => {
        const bodyAt = topBody.indexOf(b.body, b.at ?? 0);
        if (spec.parse) return spec.parse(b.body, { line: (at: number) => lineAt(Math.max(0, bodyAt) + at), ...(b.id ? { id: b.id } : {}) });
        const fields = Object.fromEntries(Object.entries(parseFields(b.body)).map(([k, v]) => [k, unquote(v)]));
        return { ...(b.id ? { id: b.id } : {}), ...fields };
      });
    }
    data[plugin.id] = own;
  }
  return { state: { plugins, data }, schemas, warnings };
}

/** The frozen view of a topology a plugin is handed. */
export function viewOf(ast: TopologyAST): ReadonlyTopology {
  const freeze = <T>(v: T): T => {
    if (v && typeof v === "object") {
      for (const k of Object.keys(v)) freeze((v as Record<string, unknown>)[k]);
      Object.freeze(v);
    }
    return v;
  };
  return freeze({
    name: ast.topology.name,
    nodes: structuredClone(ast.nodes),
    records: structuredClone(ast.records ?? []),
    persons: structuredClone(ast.persons ?? []),
    skills: structuredClone(ast.skills ?? []),
  }) as unknown as ReadonlyTopology;
}

const RULE_NAME = /^[A-Za-z0-9-]+$/;

/** Each loaded plugin's own findings. A rule id outside the plugin's namespace is a {@link PluginError}. */
export function pluginDiagnostics(ast: TopologyAST, opts: { target?: string } = {}): Diagnostic[] {
  const state = pluginStateOf(ast);
  if (!state) return [];
  const out: Diagnostic[] = [];
  for (const plugin of state.plugins) {
    if (!plugin.validate) continue;
    const found = plugin.validate(state.data[plugin.id] ?? {}, viewOf(ast), { ...(opts.target ? { target: opts.target } : {}) }) ?? [];
    for (const d of found) {
      const rule = typeof d?.rule === "string" ? d.rule : "";
      const prefix = `${plugin.id}/`;
      if (!rule.startsWith(prefix) || !RULE_NAME.test(rule.slice(prefix.length))) {
        throw new PluginError(`plugin ${plugin.id} returned rule id ${JSON.stringify(d?.rule)}; a plugin's rule ids are ${plugin.id}/<name> (letters, digits and -).`);
      }
      if (d.level !== "error" && d.level !== "warning") throw new PluginError(`plugin ${plugin.id}: rule ${rule} has level ${JSON.stringify(d.level)}; use "error" or "warning".`);
      out.push({ rule, level: d.level, message: String(d.message), ...(d.node ? { node: d.node } : {}), ...(d.line ? { line: d.line } : {}) });
    }
  }
  return out;
}

/** What the loaded plugins add to one target's scaffold, kept on the prepared AST. */
export interface PluginScaffold {
  target: string;
  /** Each file with the plugin that wrote it. */
  files: Array<{ plugin: string; path: string; content: string; executable?: boolean }>;
  settingsHooks: Array<{ plugin: string; event: string; entry: unknown }>;
  /** Gate run scripts a plugin set; a core stub at the same path gives way to the plugin's file. */
  gateScripts: Set<string>;
  /** The gates whose check a plugin set (their wrappers export AT_TOOL). */
  gateIds: Set<string>;
}

type Prepared = TopologyAST & { _pluginScaffold?: PluginScaffold };

export function pluginScaffoldOf(ast: TopologyAST): PluginScaffold | undefined {
  return (ast as Prepared)._pluginScaffold;
}

/**
 * The AST a target compiles: with no plugin output for it, `ast` itself.
 * Otherwise a clone (non-enumerable properties kept) whose gates carry the
 * plugins' `gateRuns` as `run:`, holding the plugins' files and hooks for the
 * binding to merge. Idempotent: a prepared AST is returned as it is.
 */
export function preparePluginTarget(ast: TopologyAST, target: string): TopologyAST {
  if (pluginScaffoldOf(ast)?.target === target) return ast;
  const state = pluginStateOf(ast);
  const makers = state?.plugins.filter((p) => p.scaffold?.[target]) ?? [];
  if (!state || makers.length === 0) return ast;

  const out: PluginScaffold = { target, files: [], settingsHooks: [], gateScripts: new Set(), gateIds: new Set() };
  const runs = new Map<string, string>();
  for (const plugin of makers) {
    const made = plugin.scaffold![target](state.data[plugin.id] ?? {}, viewOf(ast)) ?? {};
    for (const f of made.files ?? []) {
      if (!f || typeof f.path !== "string" || typeof f.content !== "string") throw new PluginError(`plugin ${plugin.id}: a scaffold file needs a string path and content.`);
      const p = f.path.replace(/^\.\//, "");
      if (p.startsWith("/") || p.split("/").includes("..")) throw new PluginError(`plugin ${plugin.id}: file path "${f.path}" is not inside the project.`);
      if (out.files.some((o) => o.path === p)) throw new PluginError(`plugin ${plugin.id}: file "${p}" is written by two plugins (or twice).`);
      out.files.push({ plugin: plugin.id, path: p, content: f.content, ...(f.executable ? { executable: true } : {}) });
    }
    for (const [event, entries] of Object.entries(made.settingsHooks ?? {})) {
      if (!Array.isArray(entries)) throw new PluginError(`plugin ${plugin.id}: settingsHooks.${event} is not an array.`);
      for (const entry of entries) out.settingsHooks.push({ plugin: plugin.id, event, entry });
    }
    for (const [gateId, command] of Object.entries(made.gateRuns ?? {})) {
      const gate = ast.nodes.find((n) => n.type === "gate" && n.id === gateId) as GateNode | undefined;
      if (!gate) throw new PluginError(`plugin ${plugin.id}: gateRuns names "${gateId}", which is not a gate.`);
      if (!gate.extensions?.[plugin.id]) throw new PluginError(`plugin ${plugin.id}: gate "${gateId}" has no extensions { ${plugin.id} { } }, so the plugin cannot set its check.`);
      if (gate.run) throw new PluginError(`plugin ${plugin.id}: gate "${gateId}" already has run: "${gate.run}"; a plugin sets the check only of a gate without one.`);
      if (typeof command !== "string" || command.trim() === "") throw new PluginError(`plugin ${plugin.id}: gateRuns.${gateId} is not a command.`);
      if (runs.has(gateId)) throw new PluginError(`plugin ${plugin.id}: gate "${gateId}" already gets its check from another plugin.`);
      runs.set(gateId, command);
      out.gateIds.add(gateId);
      const script = command.trim().split(/\s+/).find((w) => /\.(sh|py|js|mjs|ts|rb)$/.test(w));
      if (script) out.gateScripts.add(script.replace(/^\.\//, ""));
    }
  }

  const clone = Object.create(Object.getPrototypeOf(ast), Object.getOwnPropertyDescriptors(ast)) as Prepared;
  if (runs.size > 0) {
    clone.nodes = ast.nodes.map((n) => (n.type === "gate" && runs.has(n.id) ? ({ ...n, run: runs.get(n.id) } as GateNode) : n));
  }
  setHidden(clone, "_pluginScaffold", out);
  return clone;
}

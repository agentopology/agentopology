/**
 * The plugin API: the shape a compile-time plugin module exports.
 *
 * EXPERIMENTAL: may change before 1.0.
 *
 * A plugin adds top-level blocks to the .at language, checks them, and adds
 * files and hooks to a target's scaffold. It is loaded only by the CLI flag
 * `--plugin <module>` or by `"agentopology": { "plugins": [...] }` in the
 * project's package.json; an .at file never loads code. A plugin is code
 * that runs with your rights at compile time: load only plugins you trust.
 *
 * A module exports its plugin as the default export (or as `plugin`).
 *
 * @module
 */

/**
 * A file a plugin adds to a target's scaffold output.
 *
 * EXPERIMENTAL: may change before 1.0.
 */
export interface GeneratedFile {
  /** Path relative to the project root, e.g. ".claude/acme/widget.json". */
  path: string;
  /** The whole file content. */
  content: string;
  /** Write the file with the executable bit. */
  executable?: boolean;
}

/**
 * The read-only view of the topology a plugin's `validate` and `scaffold` get:
 * the topology's name and a frozen copy of its nodes (agents, actions, gates,
 * humans, groups), each with its id, its type and the fields the parser read,
 * `extensions` included. Changing it changes nothing.
 *
 * EXPERIMENTAL: may change before 1.0.
 */
export interface ReadonlyTopology {
  readonly name: string;
  readonly nodes: ReadonlyArray<
    Readonly<{ id: string; type: string; extensions?: Readonly<Record<string, Readonly<Record<string, unknown>>>> } & Record<string, unknown>>
  >;
}

/**
 * What a plugin's blocks parsed to, by block keyword: one entry per block
 * written (a `single` block has at most one).
 *
 * EXPERIMENTAL: may change before 1.0.
 */
export type PluginData = Record<string, unknown[]>;

/**
 * A finding a plugin's `validate` returns. Its `rule` is namespaced by the
 * plugin's id: `<id>/<name>`, `<name>` of letters, digits and `-` (e.g.
 * `acme/widget-needs-a`). Any other rule id is an error that names the plugin.
 *
 * EXPERIMENTAL: may change before 1.0.
 */
export interface Diagnostic {
  rule: string;
  level: "error" | "warning";
  message: string;
  /** The node the finding is about, if any. */
  node?: string;
  /** 1-based source line, if known (a block's `parse` gets `ctx.line`). */
  line?: number;
}

/**
 * One top-level block keyword a plugin owns.
 *
 * EXPERIMENTAL: may change before 1.0.
 */
interface PluginBlock {
  /** `single`: written at most once (a second copy is a V23 warning). `repeated`: as many as needed, each with an optional id (`widget w1 { }`). */
  multiplicity: "single" | "repeated";
  /** The `key:` fields the block takes. When given, any other name inside it is a V102 error, as in a core block. */
  fields?: string[];
  /**
   * Turn the block's body (the text between its braces) into data. `ctx.line(at)`
   * gives the 1-based source line of an offset in `body`. Without `parse`, the
   * data is `{ id?, ...fields }` with each field's value as written (quotes removed).
   */
  parse?(body: string, ctx: { line(at: number): number }): unknown;
}

/**
 * What a plugin adds to one target's scaffold.
 *
 * EXPERIMENTAL: may change before 1.0.
 */
interface PluginScaffoldOutput {
  /** Files to write. A path a core generator writes is an error. */
  files?: GeneratedFile[];
  /** settings.json hook entries by event (Claude Code). Each is checked against the hook contract; one the core already writes is an error. */
  settingsHooks?: Record<string, unknown[]>;
  /** A check command for a gate that carries `extensions { <id> { } }` and has no `run:`. It is wired as if the gate had `run:` (V135 and guard --check see it). */
  gateRuns?: Record<string, string>;
}

/**
 * A compile-time plugin.
 *
 * EXPERIMENTAL: may change before 1.0.
 */
export interface AtPlugin {
  /** The plugin's id: the name `uses-plugins: [...]` and rule ids use. */
  id: string;
  /** The plugin's own version, printed when it loads ("unversioned" without it). */
  version?: string;
  /** The plugin API version this plugin is written for. Only 1 exists. */
  apiVersion: 1;
  /** The top-level block keywords it owns. A keyword that is a core section is an error. */
  blocks: Record<string, PluginBlock>;
  /** Check the plugin's data against the topology. `ctx.target` is the target being compiled for, if any. */
  validate?(data: PluginData, view: ReadonlyTopology, ctx: { target?: string }): Diagnostic[];
  /** Per target name (e.g. "claude-code"): what the plugin adds to that target's scaffold. */
  scaffold?: Record<string, (data: PluginData, view: ReadonlyTopology) => PluginScaffoldOutput>;
}

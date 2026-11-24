/**
 * Every key the claude-code binding may write, one row each, as Claude Code's
 * docs define it. The binding writes frontmatter and settings only through
 * these rows, and validation (V130) reports what an .at states that no row
 * can place. A Claude Code update is a change to these rows (see
 * docs/claude-code-schema.md and scripts/claude-code-schema-drift.mjs).
 *
 * Settings rows are generated from the settings reference page
 * (claude-code-settings-keys.ts). Frontmatter and .mcp.json rows are by hand:
 * those pages give no per-key type line.
 *
 * @module
 */

import type { CcValueType } from "../conformance/extract-schema.js";
import { SETTINGS_KEYS, GLOBAL_CONFIG_KEYS, SETTINGS_DOC_DATE } from "./claude-code-settings-keys.js";
import { scanList } from "../parser/lexer.js";

export type { CcValueType };

/**
 * Where a key lives. `global-config` is ~/.claude.json: no binding writes it,
 * and its rows exist so validation can say why such a key is not written.
 */
export type CcSurface = "agent" | "skill" | "command" | "settings" | "mcp-server" | "global-config";

/**
 * What Claude Code does with the key, measured by a live probe where one ran:
 * `refuses` blocks a call, `grants` allows one, `steers` is read by the model,
 * `none` showed no effect, `unknown` is not measured yet.
 */
export type CcEnforcement = "refuses" | "grants" | "steers" | "none" | "unknown";

export interface CcKey {
  surface: CcSurface;
  /** The key as Claude Code spells it; a settings key is its dotted path. */
  key: string;
  type: CcValueType;
  /** The allowed values of an enum. */
  values?: readonly string[];
  /** Inclusive bounds of a number, when the docs give them. */
  min?: number;
  max?: number;
  doc: string;
  /** The Claude Code version a live probe checked the row on, or `docs <date>` when only the page was read. */
  verifiedOn: string;
  enforcement: CcEnforcement;
  /**
   * The conditions the enforcement value holds under, when a probe found it
   * depends on them. `path`: the agent is spawned as a subagent, or started
   * as the session agent (`--agent`); the value is measured on that path only.
   * `afterTrust`: nothing happens until the user trusts the project folder.
   */
  enforcedWhen?: { path?: "subagent" | "session-agent"; afterTrust?: boolean };
  /** What the probe saw, in a sentence, when the value alone would mislead. */
  note?: string;
  /** settings only: whether a project's .claude/settings.json may set the key. */
  projectFile?: boolean;
  /** The docs' removal line: Claude Code no longer reads the key, so it is not written. */
  removed?: string;
  /** The docs' deprecation line: Claude Code still reads the key, so it is written, with a warning. */
  deprecated?: string;
}

const AGENTS_DOC = "https://code.claude.com/docs/en/sub-agents.md";
const SKILLS_DOC = "https://code.claude.com/docs/en/skills.md";
const MCP_DOC = "https://code.claude.com/docs/en/mcp.md";
const SETTINGS_DOC = "https://code.claude.com/docs/en/settings-reference.md";

/** The date the frontmatter and .mcp.json pages were read. */
export const FRONTMATTER_DOC_DATE = "2026-11-17";
/** The Claude Code version the enforcement probe ran on. */
export const PROBE_VERSION = "2.1.326";

const DOCS = `docs ${FRONTMATTER_DOC_DATE}`;
const EFFORT = ["low", "medium", "high", "xhigh", "max"] as const;

type Row = Omit<CcKey, "surface" | "doc" | "verifiedOn" | "enforcement"> & Partial<Pick<CcKey, "verifiedOn" | "enforcement">>;

const rows = (surface: CcSurface, doc: string, list: Row[]): CcKey[] =>
  list.map((r) => ({ surface, doc, verifiedOn: DOCS, enforcement: "unknown", ...r }));

/** A probe row: measured on PROBE_VERSION. */
const probed = (enforcement: CcEnforcement) => ({ enforcement, verifiedOn: PROBE_VERSION });

const AGENT_KEYS = rows("agent", AGENTS_DOC, [
  { key: "name", type: "string" },
  { key: "description", type: "string", enforcement: "steers" },
  { key: "tools", type: "list", ...probed("refuses") },
  { key: "disallowedTools", type: "list", ...probed("refuses") },
  { key: "model", type: "string" },
  {
    key: "permissionMode", type: "enum", values: ["default", "acceptEdits", "auto", "dontAsk", "bypassPermissions", "plan", "manual"], ...probed("none"),
    note: "permissionMode: plan did not stop a command an allow rule permits.",
  },
  {
    key: "maxTurns", type: "number", min: 1, ...probed("refuses"), enforcedWhen: { path: "subagent" },
    note: "A subagent stopped at 1 of 3 turns; a session agent started with --agent ran past it (none).",
  },
  { key: "autoCompactWindow", type: "number", min: 100000, max: 1000000 },
  {
    key: "skills", type: "list", ...probed("steers"),
    note: "Preloads only, never refuses: a discoverable skill was followed 5/5 with or without the preload; a disable-model-invocation skill 0/5 with it.",
  },
  { key: "mcpServers", type: "list" },
  {
    key: "hooks", type: "hooks", ...probed("none"), enforcedWhen: { afterTrust: true },
    note: "none until folder trust: a PreToolUse exit 2 in a subagent's frontmatter did not block in an untrusted folder (the docs: project agents' hooks wait for trust).",
  },
  // The .at field for this arrives as the agent's `memory-scope`; until then it is reachable through the extension.
  { key: "memory", type: "enum", values: ["user", "project", "local"] },
  { key: "background", type: "boolean" },
  { key: "omitClaudeMd", type: "boolean" },
  { key: "effort", type: "enum", values: EFFORT },
  { key: "isolation", type: "enum", values: ["worktree"] },
  { key: "color", type: "enum", values: ["red", "blue", "green", "yellow", "purple", "orange", "pink", "cyan"] },
  { key: "initialPrompt", type: "string", enforcement: "steers" },
  { key: "experimental", type: "object" },
]);

/** Skill frontmatter; a command file takes the same keys except name and paths. */
const SKILL_ROWS: Row[] = [
  { key: "name", type: "string" },
  { key: "description", type: "string", enforcement: "steers" },
  { key: "when_to_use", type: "string", enforcement: "steers" },
  { key: "argument-hint", type: "string" },
  { key: "arguments", type: "list" },
  { key: "disable-model-invocation", type: "boolean" },
  { key: "user-invocable", type: "boolean" },
  { key: "allowed-tools", type: "list", ...probed("grants") },
  { key: "disallowed-tools", type: "list" },
  { key: "model", type: "string" },
  { key: "effort", type: "enum", values: EFFORT },
  { key: "context", type: "enum", values: ["fork"] },
  { key: "agent", type: "string" },
  { key: "background", type: "boolean" },
  { key: "hooks", type: "hooks" },
  { key: "paths", type: "list" },
  { key: "shell", type: "enum", values: ["bash", "powershell"] },
  { key: "metadata", type: "object" },
  { key: "license", type: "string", enforcement: "none" },
  { key: "compatibility", type: "string", enforcement: "none" },
];
const SKILL_KEYS = rows("skill", SKILLS_DOC, SKILL_ROWS);
const COMMAND_KEYS = rows("command", SKILLS_DOC, SKILL_ROWS.filter((r) => r.key !== "name" && r.key !== "paths"));

const MCP_SERVER_KEYS = rows("mcp-server", MCP_DOC, [
  { key: "type", type: "enum", values: ["stdio", "http", "sse", "ws"] },
  { key: "command", type: "string" },
  { key: "args", type: "list" },
  { key: "env", type: "object" },
  { key: "url", type: "string" },
  { key: "headers", type: "object" },
  { key: "headersHelper", type: "string" },
  { key: "timeout", type: "number" },
  { key: "alwaysLoad", type: "boolean" },
  { key: "oauth", type: "object" },
]);

/** Settings rows measured by a probe; every other settings row is `unknown` until one runs. */
const SETTINGS_ENFORCEMENT: Record<string, Pick<CcKey, "enforcement" | "verifiedOn" | "enforcedWhen" | "note">> = {
  "permissions.deny": probed("refuses"),
  "permissions.ask": probed("refuses"),
  "permissions.allow": { ...probed("grants"), enforcedWhen: { afterTrust: true }, note: "A project allow rule grants nothing until the folder is trusted; deny and ask apply at once." },
  hooks: probed("refuses"),
};

const docRow = (surface: "settings" | "global-config") => (k: (typeof SETTINGS_KEYS)[number]): CcKey => ({
  surface,
  key: k.key,
  type: k.type,
  ...(k.values ? { values: k.values } : {}),
  doc: `${SETTINGS_DOC}#${k.key.toLowerCase().replace(/\./g, "")}`,
  projectFile: k.projectFile,
  ...(k.removed ? { removed: k.removed } : {}),
  ...(k.deprecated ? { deprecated: k.deprecated } : {}),
  ...(k.key === "autoCompactWindow" ? { min: 100000, max: 1000000 } : {}),
  ...(SETTINGS_ENFORCEMENT[k.key] ?? { verifiedOn: `docs ${SETTINGS_DOC_DATE}`, enforcement: "unknown" }),
});

const SETTINGS_ROWS: CcKey[] = SETTINGS_KEYS.map(docRow("settings"));

/**
 * Keys the settings reference scopes to `Global config`, which it defines as
 * ~/.claude.json. Claude Code does not read them from a settings file, so no
 * binding writes them; validation (V130) names them when an .at sets one.
 */
const GLOBAL_CONFIG_ROWS: CcKey[] = GLOBAL_CONFIG_KEYS.map(docRow("global-config"));

/**
 * Whether Claude Code accepts a model name as written: an alias (optionally
 * with a context suffix such as [1m]), inherit, or a full claude-* model id.
 */
export function isClaudeCodeModelName(model: string): boolean {
  return /^(?:sonnet|opus|haiku|fable)(?:\[[0-9a-z]+\])?$|^inherit$|^claude-[a-z0-9.-]+(?:\[[0-9a-z]+\])?$/.test(model);
}

/** Every row. */
export const CLAUDE_CODE_SCHEMA: readonly CcKey[] = [...AGENT_KEYS, ...SKILL_KEYS, ...COMMAND_KEYS, ...MCP_SERVER_KEYS, ...SETTINGS_ROWS, ...GLOBAL_CONFIG_ROWS];

const bySurface = new Map<CcSurface, Map<string, CcKey>>();
for (const row of CLAUDE_CODE_SCHEMA) {
  if (!bySurface.has(row.surface)) bySurface.set(row.surface, new Map());
  bySurface.get(row.surface)!.set(row.key, row);
}

/** The row for a key on a surface, or undefined when Claude Code has no such key there. */
export function ccKey(surface: CcSurface, key: string): CcKey | undefined {
  return bySurface.get(surface)?.get(key);
}

/** Every row on a surface. */
export function ccKeys(surface: CcSurface): CcKey[] {
  return [...(bySurface.get(surface)?.values() ?? [])];
}

function distance(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
}

/** The known key on a surface closest to an unknown one, compared without case, `-` or `_`. */
export function nearestCcKey(surface: CcSurface, key: string): string | undefined {
  const norm = (s: string) => s.toLowerCase().replace(/[-_]/g, "");
  const want = norm(key);
  let best: { key: string; d: number } | undefined;
  for (const row of ccKeys(surface)) {
    const whole = distance(want, norm(row.key));
    const leaf = distance(want, norm(row.key.split(".").pop()!));
    const d = Math.min(whole, leaf);
    if (!best || d < best.d || (d === best.d && row.key.length < best.key.length)) best = { key: row.key, d };
  }
  return best && best.d <= Math.max(3, Math.floor(want.length / 3)) ? best.key : undefined;
}

/**
 * Where a settings key given in a topology's `extensions { claude-code }`
 * lands: its own dotted path when the schema knows it, else
 * `permissions.<key>` or `sandbox.<key>` when one of those is a row (the
 * keys people write at the top level by mistake), else a child of an object
 * row whose fields the schema does not list (`statusLine.command`).
 */
export function resolveSettingsKey(key: string): { row?: CcKey; path: string } | undefined {
  const own = ccKey("settings", key);
  if (own) return { row: own, path: key };
  for (const parent of ["permissions", "sandbox"]) {
    const nested = ccKey("settings", `${parent}.${key}`);
    if (nested) return { row: nested, path: nested.key };
  }
  const dot = key.lastIndexOf(".");
  if (dot > 0) {
    const parent = ccKey("settings", key.slice(0, dot));
    if (parent && parent.type === "object" && !listsChildren(parent.key)) return { path: key };
  }
  return undefined;
}

export type Coerced = { ok: true; value: string | number | boolean | string[] } | { ok: false; reason: string };

/** A list written in the .at as `[a, "b"]` (the parser keeps it as text) or a comma-separated string. */
export function asList(v: unknown): string[] | undefined {
  if (Array.isArray(v)) return v.map(String);
  if (typeof v !== "string") return undefined;
  const text = v.trim();
  // A quoted item may hold `,` or `]` (scanList); a malformed list is not split by guesswork.
  if (text.startsWith("[")) {
    const scanned = scanList(text, 0);
    return scanned.ok && scanned.end === text.length ? scanned.items : undefined;
  }
  return text.split(",").map((s) => s.trim().replace(/^"(.*)"$/, "$1")).filter(Boolean);
}

/**
 * The value an .at gives for a key, in the type Claude Code reads, or why it
 * cannot be written. Extension values arrive as the parser leaves them:
 * strings, booleans and whole numbers.
 */
export function coerceCcValue(row: CcKey | undefined, raw: unknown): Coerced {
  if (!row) return typeof raw === "string" || typeof raw === "number" || typeof raw === "boolean" ? { ok: true, value: raw } : { ok: false, reason: "is not a single value" };
  switch (row.type) {
    case "boolean":
      if (typeof raw === "boolean") return { ok: true, value: raw };
      if (raw === "true" || raw === "false") return { ok: true, value: raw === "true" };
      return { ok: false, reason: `must be true or false, not ${JSON.stringify(raw)}` };
    case "number": {
      const n = typeof raw === "number" ? raw : typeof raw === "string" && /^-?\d+(\.\d+)?$/.test(raw.trim()) ? Number(raw) : NaN;
      if (Number.isNaN(n)) return { ok: false, reason: `must be a number, not ${JSON.stringify(raw)}` };
      if (row.min != null && n < row.min) return { ok: false, reason: `must be at least ${row.min}, not ${n}` };
      if (row.max != null && n > row.max) return { ok: false, reason: `must be at most ${row.max}, not ${n}` };
      return { ok: true, value: n };
    }
    case "enum": {
      const s = String(raw);
      if (row.values?.includes(s)) return { ok: true, value: s };
      return { ok: false, reason: `must be one of ${row.values?.join(", ")}, not ${JSON.stringify(raw)}` };
    }
    case "string":
      if (typeof raw === "string") return { ok: true, value: raw };
      return { ok: false, reason: `must be a string, not ${JSON.stringify(raw)}` };
    case "list": {
      const list = asList(raw);
      return list ? { ok: true, value: list } : { ok: false, reason: `must be a list, not ${JSON.stringify(raw)}` };
    }
    default:
      return { ok: false, reason: `is a ${row.type === "hooks" ? "hooks block" : "map"} in Claude Code, which an extension cannot write (it takes single values and lists)` };
  }
}

/**
 * The one exception to "no key without a row": the topology's own SKILL.md
 * carries these for `import` to recognise it (parseSkillMd keys on
 * `topology:`), and `entry-agent` (the meta { entry } agent) so a tool can
 * recognise the flow map. Claude Code ignores them. They move under
 * `metadata:` (the documented place for a tool's own data) once import reads
 * them there.
 */
export const AT_OWNED_TOPOLOGY_SKILL_KEYS: readonly string[] = ["version", "topology", "patterns", "entry", "entry-agent"];

/** Frontmatter key → value, where a list is written as a YAML list. */
export type FrontmatterFields = Record<string, string | number | boolean | string[]>;

/**
 * Throw when the binding is about to write a frontmatter key Claude Code does
 * not know on that surface. A row missing here is a bug in the binding, not
 * in the user's .at: validation (V130) catches the user's side first.
 */
export function assertCcFrontmatter(surface: CcSurface, fields: FrontmatterFields, where: string, allow: readonly string[] = []): void {
  for (const key of Object.keys(fields)) {
    if (!ccKey(surface, key) && !allow.includes(key)) throw new Error(`[claude-code] internal: ${where} would get frontmatter key "${key}", which Claude Code does not know for a ${surface} (no schema row).`);
  }
}

/** True when the schema lists fields under a settings key (so an unlisted child is unknown). */
function listsChildren(key: string): boolean {
  return ccKeys("settings").some((r) => r.key.startsWith(key + "."));
}

/**
 * The paths in a settings object that have no schema row. It walks into an
 * object only where the schema lists that object's fields: `hooks`, `env` or
 * `statusLine` hold free keys.
 */
export function unknownSettingsPaths(obj: Record<string, unknown>, prefix = ""): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${k}` : k;
    if (!ccKey("settings", path)) {
      if (!prefix || listsChildren(prefix)) out.push(path);
      continue;
    }
    if (listsChildren(path) && v && typeof v === "object" && !Array.isArray(v)) out.push(...unknownSettingsPaths(v as Record<string, unknown>, path));
  }
  return out;
}

/** Set a dotted path in a settings object; a list merges into a list already there, without repeats. */
export function setSettingsPath(settings: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split(".");
  let node = settings;
  for (const p of parts.slice(0, -1)) {
    if (!node[p] || typeof node[p] !== "object" || Array.isArray(node[p])) node[p] = {};
    node = node[p] as Record<string, unknown>;
  }
  const leaf = parts[parts.length - 1];
  const prev = node[leaf];
  node[leaf] = Array.isArray(prev) && Array.isArray(value) ? [...new Set([...prev, ...value])] : value;
}

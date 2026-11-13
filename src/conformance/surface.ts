/**
 * The surface map (RW-1): everything on a platform that AgenTopology writes or
 * relies on, one entry each. `collectSurface` reads the files a binding
 * generates and lists every platform-facing item in them; `unmappedItems`
 * returns the ones the map has no entry for. A test holds the map to the
 * binding with the two, so the map cannot rot.
 */

export interface SurfaceItem {
  /** A map area, for example "hooks.events". */
  area: string;
  /** The bare name: an event, a field, a flag, a path pattern. */
  token: string;
  /** One generated file the item was seen in. */
  where: string;
}

export interface SurfaceEntry {
  id: string;
  area: string;
  tokens: string[];
  contract?: { doc?: string; snapshot?: string };
  usedBy: string | string[];
  language: string | string[];
  proof: string;
  ifBroken: string;
  grade: string;
}

export interface SurfaceMap {
  platform: string;
  areas: string[];
  entries: SurfaceEntry[];
  areaWords?: Record<string, string[]>;
  ignore?: { pattern: string; why: string }[];
  watchOnly?: { id: string; tokens: string[]; card?: string }[];
  knownDrift?: { id: string; value: string; ticket: string; why: string }[];
}

export const itemKey = (i: Pick<SurfaceItem, "area" | "token">): string => `${i.area}:${i.token}`;

type GeneratedFile = { path: string; content: string };

/** Lines of the YAML front matter, or [] when the file has none. */
function frontMatter(content: string): string[] {
  if (!content.startsWith("---\n")) return [];
  const end = content.indexOf("\n---", 4);
  return end < 0 ? [] : content.slice(4, end).split("\n");
}

/** A generated path with its ids replaced: `.claude/agents/<id>/AGENT.md` becomes `.claude/agents/*\/AGENT.md`. */
export function pathPattern(path: string): string {
  const seg = path.split("/");
  const fixed = new Set(["AGENT.md", "SKILL.md", "settings.json", ".mcp.json", "sessions.md", "transcript.md",
    "config.json", "CLAUDE.md", "crontab.fragment", "metrics.jsonl"]);
  if (seg[0] === ".claude" && ["agents", "skills", "groups"].includes(seg[1]) && seg.length > 2) seg[2] = "*";
  const last = seg.length - 1;
  if (!fixed.has(seg[last]) && !(seg[0] === ".claude" && seg[1] === "settings.json")) seg[last] = "*";
  // a file straight under scripts/ or .claude/commands|rules keeps only the folder
  return seg.join("/");
}

function pathArea(path: string): string {
  if (path.startsWith(".claude/agents/")) return "agents.file";
  if (path.startsWith(".claude/skills/")) return "skills";
  if (path === ".claude/settings.json") return "settings";
  if (path === ".mcp.json") return "mcp";
  if (path === ".claude/sessions.md" || path === "scripts/start-sessions.sh") return "sessions";
  if (path.startsWith(".claude/rules/") || path === "CLAUDE.md") return "instructions";
  if (path.startsWith(".claude-plugin/")) return "plugins";
  if (path === "crontab.fragment" || path.startsWith("scripts/schedule-")) return "schedules";
  return "files";
}

const HANDLER_FIELDS_NOT_EVENTS = new Set(["matcher", "hooks"]);

function addHookKeys(add: (area: string, token: string) => void, hooks: unknown): void {
  if (!hooks || typeof hooks !== "object") return;
  for (const [event, groups] of Object.entries(hooks as Record<string, unknown>)) {
    add("hooks.events", event);
    for (const g of Array.isArray(groups) ? groups : []) {
      if (!g || typeof g !== "object") continue;
      for (const k of Object.keys(g)) if (!HANDLER_FIELDS_NOT_EVENTS.has(k) || k === "matcher") add("hooks.handler", k);
      for (const h of Array.isArray((g as any).hooks) ? (g as any).hooks : []) {
        if (!h || typeof h !== "object") continue;
        for (const k of Object.keys(h)) add("hooks.handler", k);
        if (typeof h.type === "string") add("hooks.handler", `type:${h.type}`);
        if (typeof h.command === "string" && /(^|[;&|\s])exit 2(\s|$)/.test(h.command)) add("hooks.handler", "exit:2");
      }
    }
  }
}

/** Frontmatter `hooks:` block of an agent file: events at depth 2, handler fields below. */
function addFrontmatterHooks(add: (area: string, token: string) => void, lines: string[]): void {
  let inHooks = false;
  for (const line of lines) {
    if (/^hooks:\s*$/.test(line)) { inHooks = true; continue; }
    if (inHooks && /^\S/.test(line)) inHooks = false;
    if (!inHooks) continue;
    const ev = /^ {2}([A-Za-z]+):\s*$/.exec(line);
    if (ev) { add("hooks.events", ev[1]); continue; }
    const f = /^\s+(?:- )?([A-Za-z]+):\s*(.*)$/.exec(line);
    if (f) {
      add("hooks.handler", f[1]);
      if (f[1] === "type") add("hooks.handler", `type:${f[2].replace(/^"|"$/g, "")}`);
    }
  }
}

const TOP_PAYLOAD = new Set(["tool_input", "tool_name", "tool_response", "agent_type", "session_id", "transcript_path",
  "hook_event_name", "cwd", "prompt", "tool_use_id", "permission_mode", "agent_id"]);
const OUTPUT_KEYS = ["hookSpecificOutput", "hookEventName", "permissionDecisionReason", "permissionDecision",
  "updatedInput", "additionalContext"];

/** Payload fields a generated hook script reads from stdin, and the JSON it prints. */
function addPayload(add: (area: string, token: string) => void, content: string): void {
  for (const line of content.split("\n")) {
    if (!/\bjq\b/.test(line)) continue;
    if (line.includes("hookSpecificOutput")) {
      for (const k of OUTPUT_KEYS) if (new RegExp(`\\b${k}\\b`).test(line)) add("hooks.payload", `output.${k}`);
      continue;
    }
    if (/\bjq -nc?\b/.test(line)) continue; // builds a log line, reads no payload
    const afterQuote = line.slice(line.indexOf("'"));
    for (const m of afterQuote.matchAll(/(?<![\w$)\]])\.([a-z_]+)\b/g)) {
      const name = m[1];
      if (name === "tool_input") continue;
      add("hooks.payload", TOP_PAYLOAD.has(name) ? name : `tool_input.${name}`);
    }
    for (const m of afterQuote.matchAll(/\$[A-Za-z_]+\.([a-z_]+)\b/g)) add("hooks.payload", `tool_input.${m[1]}`);
    if (/\.tool_input\b/.test(afterQuote)) add("hooks.payload", "tool_input");
  }
}

/** Every platform-facing item in the files a Claude Code scaffold wrote. */
export function collectSurface(files: GeneratedFile[]): SurfaceItem[] {
  const seen = new Map<string, SurfaceItem>();
  for (const f of files) {
    const add = (area: string, token: string) => {
      const k = `${area}:${token}`;
      if (!seen.has(k)) seen.set(k, { area, token, where: f.path });
    };
    add(pathArea(f.path), `path:${pathPattern(f.path)}`);

    if (f.path === ".claude/settings.json") {
      const s = JSON.parse(f.content);
      for (const k of Object.keys(s)) add("settings", k);
      addHookKeys(add, s.hooks);
      for (const k of Object.keys(s.permissions ?? {})) add("permissions.rules", k);
    } else if (f.path === ".mcp.json") {
      const m = JSON.parse(f.content);
      for (const k of Object.keys(m)) add("mcp", k);
      for (const srv of Object.values<any>(m.mcpServers ?? {})) {
        for (const k of Object.keys(srv)) add("mcp", `server.${k}`);
        if (typeof srv.type === "string") add("mcp", `server.type:${srv.type}`);
      }
    } else if (f.path.endsWith(".md")) {
      const lines = frontMatter(f.content);
      const area = f.path.startsWith(".claude/agents/") ? "agents.file"
        : f.path.startsWith(".claude/skills/") ? "skills"
        : f.path.startsWith(".claude/commands/") ? "commands" : null;
      if (area && lines.length) {
        for (const l of lines) {
          const k = /^([A-Za-z][\w-]*):/.exec(l);
          if (k) add(area, `frontmatter:${k[1]}`);
          const pm = /^permissionMode:\s*(\S+)/.exec(l);
          if (pm) add("permissions.modes", pm[1]);
        }
        addFrontmatterHooks(add, lines);
      }
    }

    // CLI flags on a `claude ...` line, in sessions.md, start scripts and anywhere else
    for (const line of f.content.split("\n")) {
      const c = /(?:^|[\s'"`])claude((?:\s+-{1,2}[A-Za-z][\w-]*)(?:\s+\S+)*)/.exec(line);
      if (!c) continue;
      for (const m of c[1].matchAll(/(?:^|\s)(--?[A-Za-z][\w-]*)/g)) add("cli", m[1]);
    }
    for (const m of f.content.matchAll(/\bCLAUDE_[A-Z_]+\b/g)) add("env", m[0]);

    if (/\.(sh|py)$/.test(f.path)) {
      if (/(^|\n)\s*exit 2\b/.test(f.content)) add("hooks.handler", "exit:2");
      addPayload(add, f.content);
    }
  }
  return [...seen.values()];
}

// ---------------------------------------------------------------- Codex (RW-2)

import { parse as parseToml } from "smol-toml";

export interface SchemaMismatch {
  /** `cx.config.<dotted path>`, or `cx.knownDrift.<id>` for a drift item that breaks the rule. */
  id: string;
  path: string;
  value: unknown;
  message: string;
}

export interface KnownDrift { id: string; value: string; ticket: string; why: string }

type Json = any;

function resolveRef(ref: string, root: Json): Json {
  return ref.replace(/^#\//, "").split("/").reduce((o: Json, k) => o?.[k], root);
}

function typeOk(v: unknown, t: string): boolean {
  switch (t) {
    case "string": return typeof v === "string";
    case "boolean": return typeof v === "boolean";
    case "integer": return Number.isInteger(v);
    case "number": return typeof v === "number";
    case "array": return Array.isArray(v);
    case "object": return typeof v === "object" && v !== null && !Array.isArray(v);
    case "null": return v === null;
    default: return true;
  }
}

/** Mismatches of a value against a JSON schema (the subset config.schema.json uses). Empty list = it fits. */
function validateNode(v: unknown, node: Json, root: Json, path: string[]): SchemaMismatch[] {
  if (node === true || node === undefined) return [];
  if (node.$ref) return validateNode(v, resolveRef(node.$ref, root), root, path);
  const out: SchemaMismatch[] = [];
  const at = path.join(".");
  const bad = (message: string, value: unknown = v, p = path) =>
    out.push({ id: `cx.config.${p.join(".")}`, path: p.join("."), value, message });
  for (const sub of node.allOf ?? []) out.push(...validateNode(v, sub, root, path));
  for (const key of ["oneOf", "anyOf"] as const) {
    if (node[key] && !node[key].some((sub: Json) => validateNode(v, sub, root, path).length === 0)) {
      bad(`${at}: value ${JSON.stringify(v)} matches none of the forms the schema allows`);
    }
  }
  if (node.enum && !node.enum.includes(v)) bad(`${at}: ${JSON.stringify(v)} is not one of ${JSON.stringify(node.enum)}`);
  if (node.type) {
    const types: string[] = Array.isArray(node.type) ? node.type : [node.type];
    if (!types.some((t) => typeOk(v, t))) { bad(`${at}: expected ${types.join("|")}`); return out; }
  }
  if (typeOk(v, "object") && (node.properties || node.additionalProperties !== undefined)) {
    for (const [k, child] of Object.entries(v as Record<string, unknown>)) {
      const sub = node.properties?.[k];
      if (sub !== undefined) out.push(...validateNode(child, sub, root, [...path, k]));
      else if (node.additionalProperties === false) bad(`${[...path, k].join(".")}: the schema has no such key`, child, [...path, k]);
      else if (typeof node.additionalProperties === "object") out.push(...validateNode(child, node.additionalProperties, root, [...path, k]));
    }
  }
  if (Array.isArray(v) && node.items) v.forEach((c, i) => out.push(...validateNode(c, node.items, root, [...path, String(i)])));
  return out;
}

/**
 * Mismatches of a parsed config.toml against the Codex config schema snapshot,
 * minus the ones `knownDrift` excuses. A drift item needs a ticket id; one
 * without it excuses nothing and is reported as `cx.knownDrift.<id>`.
 */
export function checkConfigAgainstSchema(config: Record<string, unknown>, schema: Json, knownDrift: KnownDrift[] = []): SchemaMismatch[] {
  const raw = validateNode(config, schema, schema, []).filter((m) => m.path !== "" || m.message);
  const valid = knownDrift.filter((k) => /^CX-?\d+/.test(k.ticket ?? ""));
  const out = raw.filter((m) => !valid.some((k) => k.id === m.id && (k.value === "*" || k.value === String(m.value))));
  for (const k of knownDrift) {
    if (!valid.includes(k)) out.push({ id: `cx.knownDrift.${k.id}`, path: k.id, value: k.ticket, message: `knownDrift item ${k.id} has no CX ticket id` });
  }
  return out;
}

const CODEX_FIXED = new Set(["config.toml", "hooks.json", "AGENTS.md", "metrics.jsonl", "crontab.fragment", "SKILL.md"]);

export function codexPathPattern(path: string): string {
  const seg = path.split("/");
  if (seg[0] === ".agents" && seg[1] === "skills" && seg.length > 2) seg[2] = "*";
  // The guards live in .codex/scripts/<topology>/ (CX-9): the folder is a name, not a contract.
  if (seg[0] === ".codex" && seg[1] === "scripts" && seg.length > 3) seg[2] = "*";
  const last = seg.length - 1;
  const base = seg[last];
  if (!CODEX_FIXED.has(base)) {
    const dot = base.lastIndexOf(".");
    seg[last] = dot > 0 && !base.startsWith(".") ? `*${base.slice(dot)}` : "*";
  }
  return seg.join("/");
}

function codexPathArea(path: string): string {
  if (path === ".codex/config.toml") return "config.keys";
  if (path.startsWith(".codex/agents/")) return "agents";
  if (path.startsWith(".agents/skills/")) return "skills";
  if (path === ".codex/hooks.json") return "hooks";
  if (path === "AGENTS.md") return "instructions";
  if (path.startsWith(".codex/rules/")) return "permissions";
  return "files";
}

/** Config key paths with dynamic names (mcp server ids, agent role ids) replaced by `<id>`. */
function tomlKeys(obj: Record<string, unknown>, prefix: string[], out: string[][]): void {
  for (const [k, v] of Object.entries(obj)) {
    const isTable = typeof v === "object" && v !== null && !Array.isArray(v);
    const parent = prefix[prefix.length - 1];
    const dynamic = isTable && (parent === "mcp_servers" || (parent === "agents" && prefix.length === 1));
    const name = dynamic ? "<id>" : k;
    out.push([...prefix, name]);
    if (isTable && k !== "env" && k !== "headers") tomlKeys(v as Record<string, unknown>, [...prefix, name], out);
  }
}

/** Every platform-facing item in the files a Codex scaffold wrote. */
export function collectCodexSurface(files: GeneratedFile[]): SurfaceItem[] {
  const seen = new Map<string, SurfaceItem>();
  for (const f of files) {
    const add = (area: string, token: string) => {
      const k = `${area}:${token}`;
      if (!seen.has(k)) seen.set(k, { area, token, where: f.path });
    };
    add(codexPathArea(f.path), `path:${codexPathPattern(f.path)}`);
    if (f.path === ".codex/config.toml") {
      const cfg = parseToml(f.content) as Record<string, unknown>;
      const keys: string[][] = [];
      tomlKeys(cfg, [], keys);
      for (const k of keys) add(k[0] === "agents" ? "agents" : "config.keys", k.join("."));
      if (typeof cfg.approval_policy === "string") add("approvals", cfg.approval_policy);
      if (typeof cfg.sandbox_mode === "string") add("sandbox", cfg.sandbox_mode);
    } else if (f.path.startsWith(".codex/agents/") && f.path.endsWith(".toml")) {
      for (const k of Object.keys(parseToml(f.content))) add("agents", `file.${k}`);
    } else if (f.path === ".codex/hooks.json") {
      const hooks = JSON.parse(f.content).hooks ?? {};
      for (const [ev, groups] of Object.entries<any>(hooks)) {
        add("hooks", `event:${ev}`);
        for (const g of groups) {
          for (const k of Object.keys(g)) if (k !== "hooks") add("hooks", `field:${k}`);
          for (const h of g.hooks ?? []) for (const k of Object.keys(h)) add("hooks", `field:${k}`);
        }
      }
    } else if (f.path.startsWith(".agents/skills/") && f.path.endsWith("SKILL.md")) {
      for (const l of frontMatter(f.content)) {
        const k = /^([A-Za-z][\w-]*):/.exec(l);
        if (k) add("skills", `frontmatter:${k[1]}`);
      }
    }
  }
  return [...seen.values()];
}

function entryCovers(e: SurfaceEntry, i: SurfaceItem): boolean {
  return e.area === i.area && e.tokens.includes(i.token);
}

/** Items no entry, no `watchOnly` token and no `ignore` pattern accounts for. */
export function unmappedItems(items: SurfaceItem[], map: SurfaceMap): SurfaceItem[] {
  const ignores = (map.ignore ?? []).map((g) => new RegExp(g.pattern));
  return items.filter((i) => {
    if (map.entries.some((e) => entryCovers(e, i))) return false;
    if (map.watchOnly?.some((w) => w.tokens.includes(i.token))) return false;
    return !ignores.some((r) => r.test(i.token));
  });
}

/**
 * Claude Code's hook contract, extracted from the hooks reference page
 * (https://code.claude.com/docs/en/hooks.md, raw markdown) into a snapshot
 * that can be committed and diffed.
 *
 * The docs are the source of truth. The SchemaStore settings schema exists but
 * lags the CLI (the settings docs say so; on 2026-11-10 it lacked `onFailure`
 * and two of the 33 events), so it is not used here.
 *
 * What is extracted: the event names (one `###` heading each under "Hook
 * events"), the events with no matcher support, the matcher rules table, each
 * handler type's fields with whether they are required, and every "Requires
 * Claude Code vX or later" attached to an event or a field. A snapshot at an
 * older version is derived by dropping what requires a newer one.
 *
 * @module
 */

export interface FieldFact {
  required: boolean;
  /** The Claude Code version the field needs, when the docs give one. */
  requires?: string;
}

export interface HookContract {
  source: string;
  /** The date the page was read (YYYY-MM-DD). */
  fetched: string;
  /** The Claude Code version installed when it was checked, or the version this snapshot is derived for. */
  claudeCode: string;
  /** True when this snapshot was derived from a newer one by dropping what requires a newer version. */
  derived?: boolean;
  events: string[];
  eventRequires: Record<string, string>;
  noMatcherEvents: string[];
  handlerTypes: string[];
  /** Fields per handler: `common` applies to all; `prompt` covers prompt and agent hooks. */
  fields: Record<string, Record<string, FieldFact>>;
  /** The matcher table's rows ("value → evaluated as"), as written. */
  matcherRules: string[];
}

/** The lines of the section that starts at `heading` (exact line), up to the next heading of the same or higher level. */
function section(lines: string[], heading: string): string[] {
  const start = lines.findIndex((l) => l.trim() === heading);
  if (start === -1) return [];
  const level = heading.match(/^#+/)![0].length;
  const out: string[] = [];
  let fenced = false; // a "# comment" inside a code example is not a heading
  for (let i = start + 1; i < lines.length; i++) {
    if (/^\s*(```|~~~)/.test(lines[i])) fenced = !fenced;
    const h = !fenced && lines[i].match(/^(#+)\s/);
    if (h && h[1].length <= level) break;
    out.push(lines[i]);
  }
  return out;
}

/** Every markdown table in `lines`, as rows of cells; header and separator rows dropped. */
function tables(lines: string[]): string[][][] {
  const out: string[][][] = [];
  let current: string[][] | null = null;
  for (const l of lines) {
    if (!l.startsWith("|")) { current = null; continue; }
    const cells = l.replace(/\\\|/g, "\u0000").split("|").slice(1, -1).map((c) => c.trim().replace(/\u0000/g, "|"));
    if (!current) { current = []; out.push(current); continue; } // the header row
    if (cells.every((c) => /^:?-+:?$/.test(c))) continue;
    current.push(cells);
  }
  return out;
}

const tableRows = (lines: string[]): string[][] => tables(lines)[0] ?? [];

const ticked = (cell: string) => [...cell.matchAll(/`([^`]+)`/g)].map((m) => m[1]);
const REQUIRES = /Requires Claude Code v(\d+\.\d+\.\d+) or later/;

const HANDLER_SECTIONS: Record<string, string> = {
  common: "#### Common fields",
  command: "#### Command hook fields",
  http: "#### HTTP hook fields",
  mcp_tool: "#### MCP tool hook fields",
  prompt: "#### Prompt and agent hook fields",
};

/** Read the contract out of the hooks page's raw markdown. */
export function extractHookContract(markdown: string, meta: { source: string; fetched: string; claudeCode: string }): HookContract {
  const lines = markdown.split("\n");

  const eventLines = section(lines, "## Hook events");
  const events: string[] = [];
  const eventRequires: Record<string, string> = {};
  for (const l of eventLines) {
    const m = l.match(/^### ([A-Z][A-Za-z]+)\s*$/);
    if (m) events.push(m[1]);
  }
  for (const e of events) {
    for (const l of section(lines, `### ${e}`)) {
      const r = l.match(new RegExp(`^${e} requires Claude Code v(\\d+\\.\\d+\\.\\d+) or later`));
      if (r) { eventRequires[e] = r[1]; break; }
    }
  }

  // The section's first table is how a matcher is evaluated; the second, what each event's matcher filters.
  const [rules = [], perEvent = []] = tables(section(lines, "### Matcher patterns"));
  const matcherRules = rules.map((r) => `${r[0]} → ${r[1]}`);
  const noMatcherEvents = perEvent.filter((r) => /no matcher support/.test(r[1] ?? "")).flatMap((r) => ticked(r[0]));

  const fields: Record<string, Record<string, FieldFact>> = {};
  for (const [type, heading] of Object.entries(HANDLER_SECTIONS)) {
    const facts: Record<string, FieldFact> = {};
    for (const r of tableRows(section(lines, heading))) {
      const name = ticked(r[0])[0];
      if (!name) continue;
      const requires = (r[2] ?? "").match(REQUIRES)?.[1];
      facts[name] = { required: /^yes/.test(r[1] ?? ""), ...(requires ? { requires } : {}) };
    }
    fields[type] = facts;
  }
  const typeCell = tableRows(section(lines, HANDLER_SECTIONS.common)).find((r) => ticked(r[0])[0] === "type")?.[2] ?? "";
  const handlerTypes = ticked(typeCell).map((t) => t.replace(/^"|"$/g, ""));

  return { ...meta, events, eventRequires, noMatcherEvents: [...new Set(noMatcherEvents)].sort(), handlerTypes, fields, matcherRules };
}

/** -1, 0 or 1, comparing two x.y.z versions. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number), pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) < (pb[i] ?? 0) ? -1 : 1;
  return 0;
}

/** The contract as it stood at `version`: events and fields that require a newer version are dropped. */
export function contractAt(c: HookContract, version: string): HookContract {
  const newer = (v?: string) => !!v && compareVersions(v, version) > 0;
  const fields: Record<string, Record<string, FieldFact>> = {};
  for (const [type, facts] of Object.entries(c.fields)) {
    fields[type] = Object.fromEntries(Object.entries(facts).filter(([, f]) => !newer(f.requires)));
  }
  const events = c.events.filter((e) => !newer(c.eventRequires[e]));
  return {
    ...c,
    claudeCode: version,
    derived: true,
    events,
    eventRequires: Object.fromEntries(Object.entries(c.eventRequires).filter(([e]) => events.includes(e))),
    noMatcherEvents: c.noMatcherEvents.filter((e) => events.includes(e)),
    fields,
  };
}

export interface ContractDiff {
  eventsAdded: string[];
  eventsRemoved: string[];
  noMatcherAdded: string[];
  noMatcherRemoved: string[];
  handlerTypesAdded: string[];
  handlerTypesRemoved: string[];
  /** "command.onFailure" style keys. */
  fieldsAdded: string[];
  fieldsRemoved: string[];
  /** A field or event whose required flag or version changed: "command.onFailure: requires 2.1.295 → 2.1.300". */
  changed: string[];
  matcherRulesChanged: boolean;
}

const minus = (a: string[], b: string[]) => a.filter((x) => !b.includes(x));

/** What changed from `before` to `after`. */
export function diffContracts(before: HookContract, after: HookContract): ContractDiff {
  const flat = (c: HookContract) => Object.entries(c.fields).flatMap(([t, f]) => Object.keys(f).map((n) => `${t}.${n}`));
  const fact = (c: HookContract, key: string) => { const [t, n] = key.split("."); return c.fields[t]?.[n]; };
  const changed: string[] = [];
  for (const key of flat(before).filter((k) => flat(after).includes(k))) {
    const a = fact(before, key)!, b = fact(after, key)!;
    if (a.required !== b.required) changed.push(`${key}: required ${a.required} → ${b.required}`);
    if (a.requires !== b.requires) changed.push(`${key}: requires ${a.requires ?? "-"} → ${b.requires ?? "-"}`);
  }
  for (const e of before.events.filter((x) => after.events.includes(x))) {
    if (before.eventRequires[e] !== after.eventRequires[e]) changed.push(`${e}: requires ${before.eventRequires[e] ?? "-"} → ${after.eventRequires[e] ?? "-"}`);
  }
  return {
    eventsAdded: minus(after.events, before.events),
    eventsRemoved: minus(before.events, after.events),
    noMatcherAdded: minus(after.noMatcherEvents, before.noMatcherEvents),
    noMatcherRemoved: minus(before.noMatcherEvents, after.noMatcherEvents),
    handlerTypesAdded: minus(after.handlerTypes, before.handlerTypes),
    handlerTypesRemoved: minus(before.handlerTypes, after.handlerTypes),
    fieldsAdded: minus(flat(after), flat(before)),
    fieldsRemoved: minus(flat(before), flat(after)),
    changed,
    matcherRulesChanged: JSON.stringify(before.matcherRules) !== JSON.stringify(after.matcherRules),
  };
}

/** Whether a diff has anything in it. */
export function hasDrift(d: ContractDiff): boolean {
  return d.matcherRulesChanged || Object.values(d).some((v) => Array.isArray(v) && v.length > 0);
}

/** A diff as lines a person reads. */
export function renderDiff(d: ContractDiff): string[] {
  const out: string[] = [];
  const list = (label: string, xs: string[]) => { if (xs.length) out.push(`${label} (${xs.length}): ${xs.join(", ")}`); };
  list("events added", d.eventsAdded);
  list("events removed", d.eventsRemoved);
  list("now without matcher support", d.noMatcherAdded);
  list("matcher support added", d.noMatcherRemoved);
  list("handler types added", d.handlerTypesAdded);
  list("handler types removed", d.handlerTypesRemoved);
  list("fields added", d.fieldsAdded);
  list("fields removed", d.fieldsRemoved);
  list("changed", d.changed);
  if (d.matcherRulesChanged) out.push("the matcher rules table changed: re-check matcherMatches in src/conformance/claude-code.ts");
  return out.length ? out : ["no drift"];
}

/**
 * The file-writing tools, read from the tools reference page's raw markdown
 * (https://code.claude.com/docs/en/tools-reference.md, SP-7): the "Applies to"
 * cell of the `Edit(...)` rule row, the tools a path rule for edits covers.
 * Empty when the page has no such row.
 */
export function extractFileWriteTools(markdown: string): string[] {
  for (const table of tables(markdown.split("\n"))) {
    for (const row of table) {
      if (/^`Edit\(/.test(row[0] ?? "")) return (row[1] ?? "").split(",").map((t) => t.trim()).filter(Boolean);
    }
  }
  return [];
}

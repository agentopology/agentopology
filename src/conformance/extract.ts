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
 * Claude Code vX or later" attached to an event or a field, and what
 * `onFailure: "block"` covers (S-32): the failure cases, what "block" does,
 * where it has no effect, the stdout x exit-code table and the exit-1 warning,
 * each as written with its line. A snapshot at an older version is derived by
 * dropping what requires a newer one.
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
  onFailure?: OnFailureFacts;
}

/** One sentence of the page, as written (markdown kept; a leading "* " or "> " dropped), and the line it sits on. */
export interface Quote { quote: string; line: number }

export interface OnFailureFacts {
  requires: string;
  failures: Record<string, Quote>;
  block: Quote;
  noEffect: Record<string, Quote>;
  exitTable: Record<string, Quote>;
  exit1: Quote;
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

/** The line index (0-based) of the exact heading, or -1. */
const headingAt = (lines: string[], heading: string) => lines.findIndex((l) => l.trim() === heading);

/** A key for a bullet or row label: its words, lower case, joined by "-" (links and apostrophes dropped). */
export function factKey(label: string): string {
  return label.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/['’`*"]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

/** The bullets right after the line `lead` in the section at `heading`: key from the bold label, quote without "* ". */
function bulletsAfter(lines: string[], heading: string, lead: string): Record<string, Quote> {
  const start = headingAt(lines, heading);
  const body = section(lines, heading);
  const i = body.findIndex((l) => l.trim() === lead);
  const out: Record<string, Quote> = {};
  if (i === -1) return out;
  for (let j = i + 1; j < body.length; j++) {
    if (body[j].trim() === "" && Object.keys(out).length === 0) continue;
    const m = body[j].match(/^\* (\*\*(.+?)\*\*.*)$/);
    if (!m) break;
    out[factKey(m[2])] = { quote: m[1], line: start + 2 + j };
  }
  return out;
}

/** The first line in the section at `heading` that matches `re`, without a leading "> " or "* ". */
function lineIn(lines: string[], heading: string, re: RegExp): Quote | null {
  const start = headingAt(lines, heading);
  const body = section(lines, heading);
  const j = body.findIndex((l) => re.test(l));
  return j === -1 ? null : { quote: body[j].replace(/^(> |\* )/, ""), line: start + 2 + j };
}

const EXIT_SECTION = "### Exit code output";
const BLOCK_SECTION = "#### Block the action when a hook fails";

/** What onFailure: "block" covers, or undefined when the page has no such section. */
function extractOnFailure(lines: string[], requires: string | undefined): OnFailureFacts | undefined {
  const failures = bulletsAfter(lines, BLOCK_SECTION, "Each of these counts as a failure:");
  const block = lineIn(lines, BLOCK_SECTION, /^With `"block"` set, /);
  const exit1 = lineIn(lines, EXIT_SECTION, /^>\s*Exit code 1 without valid JSON/);
  if (!requires || Object.keys(failures).length === 0 || !block || !exit1) return undefined;
  const start = headingAt(lines, EXIT_SECTION);
  const body = section(lines, EXIT_SECTION);
  const exitTable: Record<string, Quote> = {};
  // The section's first table: what stdout x exit code does. Its rows, as written.
  const first = body.findIndex((l) => l.startsWith("|"));
  for (let j = first + 2; first !== -1 && j < body.length && body[j].startsWith("|"); j++) {
    exitTable[factKey(body[j].split("|")[1])] = { quote: body[j], line: start + 2 + j };
  }
  return { requires, failures, block, noEffect: bulletsAfter(lines, BLOCK_SECTION, "The field has no effect on these hooks:"), exitTable, exit1 };
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

  const onFailure = extractOnFailure(lines, fields.command?.onFailure?.requires);
  return { ...meta, events, eventRequires, noMatcherEvents: [...new Set(noMatcherEvents)].sort(), handlerTypes, fields, matcherRules, ...(onFailure ? { onFailure } : {}) };
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
  const { onFailure, ...rest } = c;
  return {
    ...rest,
    ...(onFailure && !newer(onFailure.requires) ? { onFailure } : {}),
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
  onFailureChanged: string[];
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
    onFailureChanged: onFailureChanged(before.onFailure, after.onFailure),
  };
}

/** The onFailure facts whose quote was added, removed or reworded ("failures.timeout"); a line that only moved is not drift. */
function onFailureChanged(before?: OnFailureFacts, after?: OnFailureFacts): string[] {
  const flat = (f?: OnFailureFacts): Record<string, string> => {
    if (!f) return {};
    const out: Record<string, string> = { requires: f.requires, block: f.block.quote, exit1: f.exit1.quote };
    for (const group of ["failures", "noEffect", "exitTable"] as const) for (const [k, q] of Object.entries(f[group])) out[`${group}.${k}`] = q.quote;
    return out;
  };
  const a = flat(before), b = flat(after);
  return [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((k) => a[k] !== b[k]);
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
  list("onFailure facts changed", d.onFailureChanged);
  if (d.matcherRulesChanged) out.push("the matcher rules table changed: re-check matcherMatches in src/conformance/claude-code.ts");
  return out.length ? out : ["no drift"];
}

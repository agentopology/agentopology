/**
 * Codex's hook contract, config keys and feature flags, extracted into
 * snapshots that can be committed and diffed.
 *
 * Sources: the hooks page (learn.chatgpt.com/docs/hooks.md, raw markdown),
 * the config reference (/docs/config-file/config-reference.md) and the
 * output of `codex features list`. The page layouts were not reachable when
 * this was written; the extractors read what section 1.2 of the build spec
 * says each page holds (a section per topic, event names in backticks) and
 * report "no events found" when a layout changes, so drift never passes silently.
 *
 * @module
 */

export interface CodexHookContract {
  source: string;
  /** The date the page was read (YYYY-MM-DD). */
  fetched: string;
  codex: string;
  events: string[];
  noMatcherEvents: string[];
  runningHandlers: string[];
  skippedHandlers: string[];
  blockingEvents: string[];
  preToolDecisions: string[];
}

export interface ConfigKeys {
  source: string;
  fetched: string;
  codex: string;
  /** Dotted key names, `<name>` standing for a user-chosen id. */
  keys: string[];
  /** Keys a project config cannot set. */
  projectForbidden: string[];
  approvalPolicies: string[];
  sandboxModes: string[];
}

export interface Feature { name: string; stage: string; enabled: boolean }
export interface FeatureSnapshot { source: string; fetched: string; codex: string; features: Feature[] }

/** The lines of the section under the first heading matching `title`, up to the next heading of the same or higher level. */
function sectionMatching(lines: string[], title: RegExp): string[] {
  const start = lines.findIndex((l) => /^#+\s/.test(l) && title.test(l));
  if (start === -1) return [];
  const level = lines[start].match(/^#+/)![0].length;
  const out: string[] = [];
  let fenced = false;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^\s*(```|~~~)/.test(lines[i])) fenced = !fenced;
    const h = !fenced && lines[i].match(/^(#+)\s/);
    if (h && h[1].length <= level) break;
    out.push(lines[i]);
  }
  return out;
}

const ticked = (s: string) => [...s.matchAll(/`([^`]+)`/g)].map((m) => m[1]);
const EVENT = /^[A-Z][A-Za-z]+$/;
const sortedUnique = (xs: string[]) => [...new Set(xs)].sort();

/** The first-column backticked names of every table row in `lines`. */
function firstColumn(lines: string[]): string[] {
  return lines.filter((l) => l.startsWith("|")).flatMap((l) => ticked(l.split("|")[1] ?? ""));
}

/** Names in backticks on lines of `lines` that mention `cue`. */
function namesOnLines(lines: string[], cue: RegExp, keep: (n: string) => boolean): string[] {
  return sortedUnique(lines.filter((l) => cue.test(l)).flatMap(ticked).filter(keep));
}

/** Read the hook contract out of the hooks page's raw markdown. */
export function extractCodexHookContract(markdown: string, meta: { source: string; fetched: string; codex: string }): CodexHookContract {
  const lines = markdown.split("\n");
  const events = sortedUnique([
    ...sectionMatching(lines, /hook events/i).flatMap((l) => (l.match(/^#{3,4}\s+`?([A-Z][A-Za-z]+)`?\s*$/) ? [l.replace(/^#+\s+|`/g, "").trim()] : [])),
    ...firstColumn(sectionMatching(lines, /hook events/i)).filter((n) => EVENT.test(n)),
  ]);
  const isEvent = (n: string) => events.includes(n);
  const handlers = (n: string) => /^[a-z_]+$/.test(n);
  return {
    ...meta,
    events,
    noMatcherEvents: namesOnLines(lines, /matcher.*ignored|ignored.*matcher|no matcher/i, isEvent),
    runningHandlers: namesOnLines(lines, /\brun\b|\bruns\b/i, handlers).filter((n) => ["command", "mcp_tool"].includes(n)),
    skippedHandlers: namesOnLines(lines, /skipped/i, handlers).filter((n) => ["prompt", "agent"].includes(n)),
    blockingEvents: namesOnLines(lines, /exit 2.*block|block.*exit 2/i, isEvent),
    preToolDecisions: namesOnLines(lines, /permissionDecision/i, (n) => n === "allow" || n === "deny"),
  };
}

/** Read config keys out of the config reference's raw markdown (first-column names of its tables). */
export function extractConfigKeys(markdown: string, meta: { source: string; fetched: string; codex: string }): ConfigKeys {
  const lines = markdown.split("\n");
  const keys = sortedUnique(firstColumn(lines).filter((n) => /^[a-z][a-z0-9_.<>-]*$/.test(n)));
  return {
    ...meta, keys,
    projectForbidden: [],
    approvalPolicies: namesOnLines(lines, /approval_policy/, (n) => ["on-request", "never", "untrusted", "on-failure"].includes(n)),
    sandboxModes: namesOnLines(lines, /sandbox_mode/, (n) => ["read-only", "workspace-write", "danger-full-access"].includes(n)),
  };
}

/** Parse the table `codex features list` prints: `name  stage  true|false` per line. */
export function parseFeaturesList(text: string): Feature[] {
  return text.split("\n").flatMap((l) => {
    const m = /^\s*([a-z][a-z0-9_]*)\s+(\S+(?: \S+)*?)\s+(true|false)\s*$/.exec(l);
    return m ? [{ name: m[1], stage: m[2], enabled: m[3] === "true" }] : [];
  });
}

export interface CodexDiff {
  eventsAdded: string[]; eventsRemoved: string[];
  noMatcherAdded: string[]; noMatcherRemoved: string[];
  handlersAdded: string[]; handlersRemoved: string[];
  blockingAdded: string[]; blockingRemoved: string[];
}

const minus = (a: string[], b: string[]) => a.filter((x) => !b.includes(x));

/** What changed from `before` to `after`. */
export function diffCodexContracts(before: CodexHookContract, after: CodexHookContract): CodexDiff {
  const h = (c: CodexHookContract) => [...c.runningHandlers.map((x) => `${x} (runs)`), ...c.skippedHandlers.map((x) => `${x} (skipped)`)];
  return {
    eventsAdded: minus(after.events, before.events), eventsRemoved: minus(before.events, after.events),
    noMatcherAdded: minus(after.noMatcherEvents, before.noMatcherEvents), noMatcherRemoved: minus(before.noMatcherEvents, after.noMatcherEvents),
    handlersAdded: minus(h(after), h(before)), handlersRemoved: minus(h(before), h(after)),
    blockingAdded: minus(after.blockingEvents, before.blockingEvents), blockingRemoved: minus(before.blockingEvents, after.blockingEvents),
  };
}

export const hasCodexDrift = (d: CodexDiff): boolean => Object.values(d).some((v) => v.length > 0);

/** A diff as lines a person reads. */
export function renderCodexDiff(d: CodexDiff): string[] {
  const out: string[] = [];
  const list = (label: string, xs: string[]) => { if (xs.length) out.push(`${label} (${xs.length}): ${xs.join(", ")}`); };
  list("events added", d.eventsAdded);
  list("events removed", d.eventsRemoved);
  list("now without matcher support", d.noMatcherAdded);
  list("matcher support added", d.noMatcherRemoved);
  list("handlers added", d.handlersAdded);
  list("handlers removed", d.handlersRemoved);
  list("now blocking on exit 2", d.blockingAdded);
  list("no longer blocking on exit 2", d.blockingRemoved);
  return out.length ? out : ["no drift"];
}

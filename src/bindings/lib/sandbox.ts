/**
 * The sandbox defaults for a topology with a go word (0.13.1).
 *
 * A human with `word:` makes the claude-code binding turn Claude Code's
 * sandbox on in .claude/settings.json. The sandbox stops the agent's own
 * commands from writing the files only hooks (and scaffold) write; the hooks
 * run outside it, so the go hook can still write. The route record and the
 * ledgers a step writes are not denied: the agent's commands write them, and
 * the guards' text checks protect them.
 *
 * One module for the binding (what is written), the validator (what warns)
 * and guard --check (what grades the go none), so the three agree.
 *
 * @module
 */

import type { GateNode, HumanNode, TopologyAST } from "../../parser/ast.js";
import { gateAnchors } from "../../parser/ast.js";
import { gateLedger, goLedgers } from "../../parser/ledger.js";
import { sessionAgentsOf, talkEdgesOf } from "../../parser/session-graph.js";
import { isSandboxPath } from "./threat.js";
import { asList as ccAsList } from "../claude-code-schema.js";

const MANIFEST = ".claude/.scaffold-manifest.json";
const TALK_LOG = ".claude/state/talk.jsonl";

/** A human who carries a go word. */
function wordHumans(ast: TopologyAST): HumanNode[] {
  return ast.nodes.filter((n): n is HumanNode => n.type === "human" && typeof n.word === "string" && n.word.trim() !== "");
}

/** True when the topology has a human with a go word: the sandbox defaults apply. */
export function hasGoWord(ast: TopologyAST): boolean {
  return wordHumans(ast).length > 0;
}

const bare = (p: string) => p.replace(/^\.\//, "");

export interface SandboxPlan {
  /** Project-relative, no leading `./`: the files only a hook or scaffold writes. */
  paths: string[];
  /** The files scaffold creates empty when missing (ledgers and the talk log, not the manifest). */
  create: string[];
  /** `sandbox.filesystem.denyWrite` entries. */
  denyWrite: string[];
  /** `permissions.deny` entries. */
  editDeny: string[];
}

/** The plan for a topology; null without a go word. */
export function sandboxPlan(ast: TopologyAST): SandboxPlan | null {
  const humans = wordHumans(ast);
  if (humans.length === 0) return null;
  // A record a gate after a step reads is written by that step: not denied.
  const stepWritten = new Set<string>();
  const humanIds = new Set(ast.nodes.filter((n) => n.type === "human").map((n) => n.id));
  for (const n of ast.nodes) {
    if (n.type !== "gate") continue;
    const gate = n as GateNode;
    if (!gateAnchors(gate, "after").some((a) => !humanIds.has(a))) continue;
    const rec = gateLedger(ast, gate);
    if (rec) stepWritten.add(bare(rec.path));
  }
  const ledgers: string[] = [];
  for (const h of humans) {
    for (const r of goLedgers(ast, h.id)) {
      const p = bare(r.path);
      if (p.includes("{unit}") || stepWritten.has(p) || ledgers.includes(p)) continue;
      ledgers.push(p);
    }
  }
  const incoming = new Set(talkEdgesOf(ast).map((e) => e.to));
  const talk = talkEdgesOf(ast).length > 0 || sessionAgentsOf(ast).some((a) => (a.decides?.length ?? 0) > 0 && incoming.has(a.id));
  const create = [...ledgers, ...(talk ? [TALK_LOG] : [])];
  const paths = [...create, MANIFEST];
  return { paths, create, denyWrite: paths.map((p) => `./${p}`), editDeny: paths.map((p) => `Edit(/${p})`) };
}

/** What the sandbox says about itself, from the AST (the validator, scaffold) or from a settings.json read off disk (guard --check). */
export interface SandboxValues {
  enabled?: unknown;
  allowUnsandboxedCommands?: unknown;
  failIfUnavailable?: unknown;
  allowWrite?: unknown;
  allowedDomains?: unknown;
}

const asList = (v: unknown): string[] => ccAsList(v) ?? [];
const isFalse = (v: unknown) => v === false || v === "false";
const isTrue = (v: unknown) => v === true || v === "true";

/** The sandbox as the AST gives it: the defaults, settings { sandbox }, the threat model, then the extensions. */
export function sandboxFromAst(ast: TopologyAST): SandboxValues {
  const ext = ast.extensions?.["claude-code"] ?? {};
  const out: SandboxValues = { enabled: true, allowUnsandboxedCommands: false, failIfUnavailable: true, allowWrite: [], allowedDomains: [] };
  if (typeof ast.settings?.sandbox === "boolean") out.enabled = ast.settings.sandbox;
  const allow = asList(ast.threatModel?.outsideSandbox).filter(isSandboxPath);
  out.allowWrite = [...allow, ...asList(ext["sandbox.filesystem.allowWrite"])];
  // boundary { outbound } hosts are written to the allow-list with the sandbox (lib/boundaries.ts), then the extensions.
  const hosts = [...new Set((ast.boundaries ?? []).flatMap((b) => b.outbound))];
  out.allowedDomains = [...new Set([...hosts, ...asList(ext["sandbox.network.allowedDomains"])])];
  if ("sandbox.enabled" in ext) out.enabled = ext["sandbox.enabled"];
  if ("sandbox.allowUnsandboxedCommands" in ext) out.allowUnsandboxedCommands = ext["sandbox.allowUnsandboxedCommands"];
  if ("sandbox.failIfUnavailable" in ext) out.failIfUnavailable = ext["sandbox.failIfUnavailable"];
  return out;
}

/** The sandbox keys of a parsed settings.json. */
export function sandboxFromSettings(settings: any): SandboxValues {
  const s = settings?.sandbox;
  if (!s || typeof s !== "object") return {};
  return {
    enabled: s.enabled,
    allowUnsandboxedCommands: s.allowUnsandboxedCommands,
    failIfUnavailable: s.failIfUnavailable,
    allowWrite: s.filesystem?.allowWrite,
    allowedDomains: s.network?.allowedDomains,
  };
}

/** An allowWrite entry covers a denied path: the path itself, a folder above it, or a glob that matches it. */
function covers(entry: string, path: string): boolean {
  let e = entry.trim();
  if (e === "" || e.startsWith("~")) return false;
  if (e === "/" ) return false;
  if (e.includes("*")) {
    const re = new RegExp("^" + e.replace(/^\.\//, "").replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*\*/g, "\u0000").replace(/\*/g, "[^/]*").replace(/\u0000/g, ".*") + "$");
    return re.test(path);
  }
  e = e.replace(/^\.\//, "").replace(/\/+$/, "");
  if (e === "." || e === "") return true;
  return path === e || path.startsWith(e + "/");
}

export interface SandboxWeakening { key: string; why: string }

/** The values that weaken a default. A value not set counts as weak: Claude Code's default is off, or (allowUnsandboxedCommands) true. */
export function sandboxWeakenings(v: SandboxValues, plan: SandboxPlan): SandboxWeakening[] {
  const out: SandboxWeakening[] = [];
  if (v.enabled !== true && !isTrue(v.enabled)) out.push({ key: "sandbox.enabled", why: v.enabled === undefined ? "is not set, so the sandbox is off" : "is false, so no command is sandboxed" });
  if (!isFalse(v.allowUnsandboxedCommands) && v.allowUnsandboxedCommands !== false) out.push({ key: "sandbox.allowUnsandboxedCommands", why: v.allowUnsandboxedCommands === undefined ? "is not set, so a command the sandbox stops can run again outside it" : "is true, so a command the sandbox stops can run again outside it" });
  if (!isTrue(v.failIfUnavailable)) out.push({ key: "sandbox.failIfUnavailable", why: v.failIfUnavailable === undefined ? "is not set, so a session starts unsandboxed where the sandbox cannot run" : "is false, so a session starts unsandboxed where the sandbox cannot run" });
  const hit = asList(v.allowWrite).flatMap((e) => plan.paths.filter((p) => covers(e, p)).map((p) => `${e} covers ${p}`));
  if (hit.length > 0) out.push({ key: "sandbox.filesystem.allowWrite", why: `allows a write to a path the sandbox denies (${[...new Set(hit)].join("; ")})` });
  return out;
}

/** The text of one weakening, as validate and scaffold say it. */
export function weakeningMessage(w: SandboxWeakening): string {
  return `${w.key} ${w.why}, which weakens the sandbox a go word turns on: the go ledger and the files hooks write are then writable by the agent's commands. It is kept as written; remove it to keep the default.`;
}

/** The warning for an empty network allow-list. */
export const NO_HOSTS_MESSAGE =
  "the sandbox allows no network hosts: npm, git over HTTPS and curl will prompt or fail; list your hosts in extensions { claude-code { sandbox.network.allowedDomains: [...] } }. " +
  "docker does not run inside the sandbox: add it to extensions { claude-code { sandbox.excludedCommands: [...] } } (a call is excluded only when every command in it matches an entry). " +
  "SSH git does not work in the macOS sandbox: use HTTPS.";

/** Why the go is not protected by the sandbox on disk: the notes guard --check gives. Empty when it is. */
export function sandboxProblems(ast: TopologyAST, settings: unknown): string[] {
  const plan = sandboxPlan(ast);
  if (!plan) return [];
  return sandboxWeakenings(sandboxFromSettings(settings), plan).map((w) => `.claude/settings.json: ${w.key} ${w.why}; the go ledger is not protected from the agent's commands`);
}

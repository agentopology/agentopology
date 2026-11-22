/**
 * The stub count validate and scaffold print.
 *
 * A stub is a generated script that carries the stub marker: scaffold could
 * not write it because the topology names the script but not its code (a
 * gate's check, a hook's script, an action with no commands, a tool). Each
 * generator that decides to write one tags the file with its kind
 * (GeneratedFile.stub), so the count is read from the binding's own output:
 * validate runs the binding with its warnings muted (plannedStubs), scaffold
 * counts the files it just planned (stubsOf). Neither repeats the decision.
 *
 * A stub path that already holds a file without the marker is the user's own
 * script: scaffold never writes over it, so it is not counted.
 *
 * @module
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { TopologyAST } from "../parser/ast.js";
import type { GeneratedFile } from "../bindings/types.js";
import { bindings } from "../bindings/index.js";
import { isStubContent, type StubKind } from "../bindings/lib/stub.js";

export interface StubEntry { kind: StubKind; path: string }

export interface StubPlan {
  /** Files the binding generates. */
  files: number;
  /** The stubs among them, in generation order. */
  stubs: StubEntry[];
  /** Stub paths that already hold the user's own file (only with a project root). */
  yours: string[];
}

/** Kinds in the order a count line names them, with their singular and plural words. */
const KINDS: Array<[StubKind, string, string]> = [
  ["gate", "gate check script", "gate check scripts"],
  ["hook", "hook script", "hook scripts"],
  ["action", "action script", "action scripts"],
  ["tool", "tool script", "tool scripts"],
  ["metering", "metering script", "metering scripts"],
  ["workflow", "workflow launch script", "workflow launch scripts"],
  ["other", "other script", "other scripts"],
];

/** True when `root/file` exists and is not a stub: the user's own script. */
function heldByUser(root: string, file: string): boolean {
  try {
    return !isStubContent(fs.readFileSync(path.join(root, file), "utf-8"));
  } catch {
    return false;
  }
}

/** The stubs among generated files; with a project root, the paths that already hold the user's file are set apart. */
export function stubsOf(files: GeneratedFile[], root?: string): { stubs: StubEntry[]; yours: string[] } {
  const stubs: StubEntry[] = [];
  const yours: string[] = [];
  for (const f of files) {
    if (!isStubContent(f.content)) continue;
    if (root && heldByUser(root, f.path)) yours.push(f.path);
    else stubs.push({ kind: f.stub ?? "other", path: f.path });
  }
  return { stubs, yours };
}

/**
 * What `scaffold --target <target>` would write as stubs for this topology:
 * the binding's own output, its warnings muted (scaffold prints them). Null
 * for an unknown target or a topology the binding refuses.
 */
export function plannedStubs(ast: TopologyAST, target: string, root?: string): StubPlan | null {
  const binding = bindings[target];
  if (!binding) return null;
  const warn = console.warn;
  console.warn = () => {};
  let files: GeneratedFile[];
  try {
    files = binding.scaffold(ast);
  } catch {
    return null;
  } finally {
    console.warn = warn;
  }
  return { files: files.length, ...stubsOf(files, root) };
}

/** How many stubs of each kind, in the count line's order, kinds with none left out. */
export function stubKindCounts(stubs: StubEntry[]): Partial<Record<StubKind, number>> {
  const out: Partial<Record<StubKind, number>> = {};
  for (const [kind] of KINDS) {
    const n = stubs.filter((s) => s.kind === kind).length;
    if (n > 0) out[kind] = n;
  }
  return out;
}

/** "1 gate check script, 2 hook scripts": the count by kind as words. */
export function stubKindLine(stubs: StubEntry[]): string {
  const counts = stubKindCounts(stubs);
  return KINDS.filter(([kind]) => counts[kind]).map(([kind, one, many]) => `${counts[kind]} ${counts[kind] === 1 ? one : many}`).join(", ");
}

/** The lines validate prints for a plan: none when nothing is a stub or the user's. */
export function stubPlanLines(plan: StubPlan, target: string): string[] {
  const lines: string[] = [];
  if (plan.stubs.length > 0) {
    lines.push(`stubs (${target}): ${plan.stubs.length} of ${plan.files} generated files are stubs: ${stubKindLine(plan.stubs)}`);
  }
  if (plan.yours.length > 0) {
    const shown = plan.yours.slice(0, 5).join(", ") + (plan.yours.length > 5 ? `, and ${plan.yours.length - 5} more` : "");
    lines.push(plan.yours.length === 1
      ? `1 stub path already holds your own file: ${shown}`
      : `${plan.yours.length} stub paths already hold your own files: ${shown}`);
  }
  return lines;
}

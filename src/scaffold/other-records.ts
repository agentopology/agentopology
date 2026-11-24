/**
 * What other .at files' manifests in a folder hold, for `validate --dir` and
 * `guard --check`.
 *
 * Each .at scaffolded into a folder has its own manifest (`source` names
 * the .at), and scaffold changes only the hook entries its own manifest
 * records: two topologies in one folder coexist. So a hook another .at
 * recorded stays when this .at is scaffolded, and these lines say whose it
 * is. Scaffold's own output does not change.
 *
 * @module
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

import { parse } from "../parser/index.js";
import type { HookRecord, ScaffoldManifest } from "./types.js";

const MANIFEST = /^\.scaffold-manifest(?:\..+)?\.json$/;

/** Every manifest in the target's folder (`.claude/` or `.codex/`) that reads as one. */
export function manifestsIn(root: string, target: string): ScaffoldManifest[] {
  const dir = join(root, target === "codex" ? ".codex" : ".claude");
  let names: string[];
  try {
    names = readdirSync(dir).filter((n) => MANIFEST.test(n)).sort();
  } catch {
    return [];
  }
  const out: ScaffoldManifest[] = [];
  for (const n of names) {
    try {
      const m = JSON.parse(readFileSync(join(dir, n), "utf-8")) as ScaffoldManifest;
      if (m && typeof m === "object" && typeof m.source === "string") out.push(m);
    } catch {
      // not a manifest this reads; scaffold reports its own
    }
  }
  return out;
}

/** The hooks file a target's manifest records entries in. */
function hooksFileOf(target: string): string {
  return target === "codex" ? ".codex/hooks.json" : ".claude/settings.json";
}

/** Each entry of a hooks file, as `<event>\t<matcher>\t<command>` (matcher `null` when none). */
function entriesOf(root: string, file: string): string[] {
  try {
    const doc = JSON.parse(readFileSync(join(root, file), "utf-8")) as { hooks?: Record<string, unknown> };
    const out: string[] = [];
    for (const [event, groups] of Object.entries(doc.hooks ?? {})) {
      if (!Array.isArray(groups)) continue;
      for (const g of groups as Array<{ matcher?: unknown; hooks?: unknown }>) {
        if (!Array.isArray(g?.hooks)) continue;
        const matcher = typeof g.matcher === "string" ? g.matcher : null;
        for (const h of g.hooks as Array<{ command?: unknown }>) {
          if (typeof h?.command === "string") out.push(JSON.stringify([event, matcher, h.command]));
        }
      }
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * One line per other .at whose manifest records hook entries the hooks file
 * still holds: `kept: N hook(s) in settings.json are recorded by <other
 * .at>'s manifest; scaffold that .at to change them`.
 */
export function otherRecordLines(root: string, target: string, source: string): string[] {
  const file = hooksFileOf(target);
  const onDisk = entriesOf(root, file);
  const lines: string[] = [];
  for (const m of manifestsIn(root, target)) {
    if (m.source === source) continue;
    const record = (m.hooks?.[file] ?? []) as HookRecord[];
    const left = [...onDisk];
    let n = 0;
    for (const r of record) {
      const i = left.indexOf(JSON.stringify([r.event, r.matcher, r.command]));
      if (i === -1) continue;
      left.splice(i, 1);
      n++;
    }
    if (n > 0) lines.push(`kept: ${n} hook(s) in ${basename(file)} are recorded by ${m.source}'s manifest; scaffold that .at to change them`);
  }
  return lines;
}

/**
 * A warning per topology name that two or more .at files declare: the .at
 * being read and the .at files the folder's manifests name (looked up beside
 * it). Two such files would each claim the topology's output.
 */
export function sameTopologyLines(root: string, target: string, atPath: string, name: string): string[] {
  const here = dirname(atPath);
  const byName = new Map<string, Set<string>>([[name, new Set([basename(atPath)])]]);
  for (const m of manifestsIn(root, target)) {
    if (m.source === basename(atPath)) continue;
    const p = join(here, m.source);
    if (!existsSync(p)) continue;
    let other: string;
    try {
      other = parse(readFileSync(p, "utf-8")).topology.name;
    } catch {
      continue;
    }
    if (!byName.has(other)) byName.set(other, new Set());
    byName.get(other)!.add(m.source);
  }
  return [...byName]
    .filter(([, files]) => files.size > 1)
    .map(([n, files]) => `two .at files declare topology ${n}: ${[...files].sort().join(", ")}`);
}

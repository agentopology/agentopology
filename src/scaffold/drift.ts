/**
 * Structure drift: where the .at and the agent, skill and command files on
 * disk disagree, key by key. Reads; never writes.
 *
 * The same decision scaffold makes (structure.ts), with nothing applied: each
 * row says what scaffold would do with that key. Formatting alone (a comma
 * string against a YAML list, quoting, key order) is never a row.
 *
 * @module
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import type { TopologyAST } from "../parser/ast.js";
import { claudeCodeBinding } from "../bindings/claude-code.js";
import { echoFields } from "./echo.js";
import { readManifest } from "./manifest.js";
import { planStructurePatch } from "./structure.js";
import { showFieldValue } from "./frontmatter-patch.js";
import { keptSettings } from "./settings-kept.js";
import { hashContent } from "./manifest.js";
import { staleBodyNotice } from "./regions.js";
import { SETTINGS_PATH } from "./undeclared.js";
import type { DriftRow } from "./types.js";

export interface DriftReport {
  /** Owned keys across the files that exist. */
  ownedKeys: number;
  rows: DriftRow[];
}

/** Compare the .at with the project at `root`; `source` is the .at file name (its manifest). */
export function structureDrift(ast: TopologyAST, root: string, source: string): DriftReport {
  const warn = console.warn;
  console.warn = () => {};
  let structure;
  let files;
  try {
    ({ structure, files } = claudeCodeBinding.scaffoldStructured!(ast));
  } finally {
    console.warn = warn;
  }
  const manifest = readManifest(root, "claude-code", source);
  const rows: DriftRow[] = [];
  let ownedKeys = 0;
  for (const spec of structure) {
    const abs = join(root, spec.path);
    if (!existsSync(abs) || !statSync(abs).isFile()) continue;
    ownedKeys += spec.owned.length;
    const text = readFileSync(abs, "utf-8");
    const action = planStructurePatch(spec, text, manifest?.fields?.[spec.path], false, echoFields(ast, spec, text));
    if (action.type === "patch") {
      rows.push(...(action.rows ?? []));
      // A scaffolded agent file whose body is the user's: the generated
      // sections the .at changed that scaffold does not write into it.
      const entry = manifest?.files[spec.path];
      const generated = files.find((f) => f.path === spec.path)?.content;
      const notice = entry && generated !== undefined && hashContent(text) !== entry.hash ? staleBodyNotice(text, generated, entry) : null;
      if (notice) rows.push({ path: spec.path, kind: spec.kind, id: spec.id, key: null, state: "kept", at: null, file: null, base: null, detail: notice });
    }
    else if (action.type === "blocked") {
      rows.push({ path: spec.path, kind: spec.kind, id: spec.id, key: action.key ?? null, state: "blocked", at: null, file: null, base: null, detail: action.detail });
    }
  }
  // settings.json: each value the .at states that the file holds otherwise
  // (the merge never replaces one), as a `kept` row.
  const settings = files.find((f) => f.path === SETTINGS_PATH);
  const settingsAbs = join(root, SETTINGS_PATH);
  if (settings && existsSync(settingsAbs) && statSync(settingsAbs).isFile()) {
    for (const k of keptSettings(readFileSync(settingsAbs, "utf-8"), settings.content, SETTINGS_PATH)) {
      rows.push({
        path: SETTINGS_PATH,
        kind: "settings",
        id: "settings",
        key: k.key,
        state: "kept",
        at: JSON.stringify(k.at),
        file: k.file === undefined ? null : JSON.stringify(k.file),
        base: null,
        detail: k.line,
      });
    }
  }
  return { ownedKeys, rows };
}

/** The human form: nothing when in sync. */
export function renderDrift(report: DriftReport): string[] {
  if (report.rows.length === 0) return [];
  const keyed = report.rows.filter((r) => r.key !== null && r.kind !== "settings").length;
  const settings = report.rows.length - report.rows.filter((r) => r.kind !== "settings").length;
  const bodies = report.rows.filter((r) => r.key === null && r.state === "kept").length;
  const lines = [
    `Structure drift (${keyed} of ${report.ownedKeys} owned keys)` +
      (bodies > 0 ? `; ${bodies} file body(ies) kept with generated sections not refreshed` : "") +
      (settings > 0 ? `; settings.json: ${settings} value(s) the .at states kept as the file has them` : ""),
  ];
  const width = Math.max(...report.rows.map((r) => r.path.length));
  for (const r of report.rows) {
    if (r.kind === "settings") {
      const why = r.file === null ? "file has no value" : `file ${r.file}`;
      lines.push(`  ${r.path.padEnd(width)}  ${r.key}  ${r.state}  .at ${r.at}  ${why} (settings.json values the file holds are never replaced)`);
      continue;
    }
    if (r.key === null || r.state === "blocked") {
      lines.push(`  ${r.path.padEnd(width)}  ${r.key === null ? "" : `${r.key}  `}${r.state}  ${r.detail ?? ""}`);
      continue;
    }
    const k = r.key;
    const show = (v: unknown) => showFieldValue((v ?? undefined) as Parameters<typeof showFieldValue>[0], k);
    const parts = [`.at ${show(r.at)}`, `file ${show(r.file)}`];
    if (r.base !== null) parts.push(`last applied ${show(r.base)}`);
    lines.push(`  ${r.path.padEnd(width)}  ${k}  ${r.state}  ${parts.join("  ")}`);
  }
  lines.push(
    "scaffold writes at-ahead keys and removes at-removed ones; it keeps file-ahead, conflict and released keys " +
      "as the file has them (--force takes the .at's value). It never writes a file's text.",
  );
  return lines;
}

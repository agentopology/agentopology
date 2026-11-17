/**
 * Structure patches: the .at's frontmatter keys into a file that is the user's.
 *
 * The .at owns structure (the frontmatter keys it states); the file owns
 * content (its body and every key the .at does not state). For each owned key
 * the rule is three-way, with D the .at's value, L the file's, and B the value
 * scaffold last applied (recorded in the manifest):
 *
 * - D equals L: nothing to do; B becomes D.
 * - no B: D is written, and said (one line per key; nothing silent).
 * - L equals B (only the .at changed): D is written.
 * - D equals B (only the file changed): the file's value stays, reported as
 *   drift; --force writes D.
 * - all three differ: the file's value stays, reported as a conflict naming
 *   both values; --force writes D.
 * A key B holds that the .at no longer states leaves the file only when the
 * file still holds B; otherwise it stays and is reported. The body is never
 * written, with or without --force.
 *
 * @module
 */

import type { StructureSpec } from "../bindings/types.js";
import type { DriftRow, FileAction, ScaffoldManifest } from "./types.js";
import {
  patchFrontmatter,
  readFrontmatter,
  sameFieldValue,
  showFieldValue,
  type FieldValue,
  type FrontmatterEdit,
} from "./frontmatter-patch.js";

/** The patch for one file, or a refusal (`blocked`) when its frontmatter cannot be edited safely. */
export function planStructurePatch(
  spec: StructureSpec,
  existing: string,
  base: Record<string, FieldValue> | undefined,
  force: boolean,
  echo: Record<string, FieldValue> | null = null,
): FileAction {
  const path = spec.path;
  const gen = readFrontmatter(spec.content);
  // What the .at states must read back before anything is compared or
  // written; a value the writer cannot read is refused out loud, never
  // taken as "nothing to do".
  if (!gen.ok) {
    return {
      type: "blocked",
      path,
      detail: `frontmatter not patched: the .at's value cannot be read back (${gen.message})`,
      ...(gen.key ? { key: gen.key } : {}),
    };
  }
  const wanted = gen.fields;
  const owned = spec.owned.filter((k) => wanted.has(k));
  const released = Object.keys(base ?? {}).filter((k) => !owned.includes(k));
  const nothing: FileAction = { type: "patch", path, content: null, changes: [], notes: [], fields: {} };
  if (owned.length === 0 && released.length === 0) return nothing;

  const cur = readFrontmatter(existing);
  if (!cur.ok) return { type: "blocked", path, detail: `frontmatter not patched: ${cur.message}`, ...(cur.key ? { key: cur.key } : {}) };

  // The file's value as the .at would state it (see echo.ts); the literal
  // value where import does not read the key. Compared, never written.
  const seen = (k: string): FieldValue | undefined => echo?.[k] ?? cur.fields.get(k)?.value;
  const dflt = (k: string, v: FieldValue | undefined) => v ?? spec.defaults?.[k];
  const same = (k: string, a: FieldValue | undefined, b: FieldValue | undefined) =>
    sameFieldValue(k, dflt(k, a), dflt(k, b));
  const show = (k: string, v: FieldValue | undefined) => showFieldValue(v, k);

  const edits: FrontmatterEdit[] = [];
  const changes: string[] = [];
  const notes: string[] = [];
  const rows: DriftRow[] = [];
  const fields: Record<string, FieldValue> = {};
  const kept = " (kept the file's; --force takes the .at's)";
  const row = (key: string, state: DriftRow["state"], at?: FieldValue, file?: FieldValue, was?: FieldValue) =>
    rows.push({ path, kind: spec.kind, id: spec.id, key, state, at: at ?? null, file: file ?? null, base: was ?? null });

  for (const k of owned) {
    const want = wanted.get(k)!;
    const d = want.value;
    const l = cur.fields.get(k)?.value;
    const s = seen(k);
    const b = base?.[k];
    if (same(k, d, l) || same(k, d, s)) {
      fields[k] = d;
      continue;
    }
    const state = b === undefined || same(k, s, b) ? "at-ahead" : same(k, d, b) ? "file-ahead" : "conflict";
    // Before a key is written over a value the file holds: that value must
    // read the same to this writer and to import (which the .at may come
    // from), unless the file still holds what scaffold applied. Otherwise
    // the .at's value may be built on a misreading, and writing it would put
    // that misreading into the user's file: the key is refused, with or
    // without --force, and said.
    const unread = (state === "at-ahead" || force) && l !== undefined && !(b !== undefined && same(k, l, b))
      ? unfaithful(k, l!, echo, d, (a, x) => same(k, a, x))
      : null;
    if (unread) {
      const note = `${k} not written: ${unread}, so the .at's ${show(k, d)} may come from a misreading (kept the file's; edit it by hand)`;
      rows.push({ path, kind: spec.kind, id: spec.id, key: k, state: "blocked", at: d, file: l ?? null, base: b ?? null, detail: note });
      notes.push(note);
      if (b !== undefined) fields[k] = b;
      continue;
    }
    row(k, state, d, l, b);
    if (state === "at-ahead" || force) {
      edits.push({ key: k, lines: want.lines });
      changes.push(`${k} ${show(k, l)} → ${show(k, d)}`);
      fields[k] = d;
    } else if (state === "file-ahead") {
      notes.push(`${k} is ${show(k, l)} in the file, ${show(k, d)} in the .at${kept}`);
      fields[k] = b!;
    } else {
      notes.push(`${k} changed on both sides: .at ${show(k, d)}, file ${show(k, l)}, last applied ${show(k, b)}${kept}`);
      fields[k] = b!;
    }
  }

  for (const k of released) {
    const l = cur.fields.get(k)?.value;
    const b = base![k];
    if (l === undefined) continue;
    if (same(k, l, b) || same(k, seen(k), b)) {
      row(k, "at-removed", undefined, l, b);
      edits.push({ key: k, remove: true });
      changes.push(`${k} ${show(k, l)} → (removed)`);
    } else {
      row(k, "released", undefined, l, b);
      notes.push(`${k} left the .at; the file's ${show(k, l)} differs from what scaffold applied (${show(k, b)}), kept`);
    }
  }

  if (edits.length === 0) return { ...nothing, notes, fields, rows };
  const r = patchFrontmatter(existing, edits);
  if (!r.ok) return { type: "blocked", path, detail: `frontmatter not patched: ${r.message}`, ...(r.key ? { key: r.key } : {}) };
  return { type: "patch", path, content: r.changed ? r.text : null, changes: r.changed ? changes : [], notes, fields, rows };
}

/**
 * Why the file's value of a key cannot be trusted as read, or null: import
 * reads it otherwise than this writer does (`echo` is import's reading), or
 * it is a nested block where the .at states a single value or a list.
 */
function unfaithful(
  key: string,
  file: FieldValue,
  echo: Record<string, FieldValue> | null,
  want: FieldValue,
  same: (a: FieldValue | undefined, b: FieldValue | undefined) => boolean,
): string | null {
  const isBlock = (v: FieldValue) => typeof v === "object" && !Array.isArray(v);
  if (isBlock(file) && !isBlock(want)) {
    return `the file's value ${showFieldValue(file, key)} is a block this writer does not read as one value`;
  }
  if (echo && !same(echo[key], file)) {
    return `import reads the file's ${showFieldValue(file, key)} as ${showFieldValue(echo[key], key)}`;
  }
  return null;
}

/** The owned keys' values as the .at states them: the base after a full write. */
export function specFields(spec: StructureSpec): Record<string, FieldValue> {
  const gen = readFrontmatter(spec.content);
  const fields: Record<string, FieldValue> = {};
  if (!gen.ok) return fields;
  for (const k of spec.owned) {
    const f = gen.fields.get(k);
    if (f) fields[k] = f.value;
  }
  return fields;
}

/**
 * The manifest's `fields` after a run: what this run applied or found equal,
 * and the earlier base for a file it could not read or did not reach.
 */
export function nextManifestFields(
  actions: FileAction[],
  structure: StructureSpec[],
  previous: ScaffoldManifest | null,
  written: Map<string, string>,
): Record<string, Record<string, FieldValue>> {
  const specs = new Map(structure.map((s) => [s.path, s]));
  const out: Record<string, Record<string, FieldValue>> = {};
  for (const a of actions) {
    const spec = specs.get(a.path);
    if (!spec) continue;
    let fields: Record<string, FieldValue> | undefined;
    if (a.type === "patch") {
      // A failed write leaves the file as it was: keep the old base.
      fields = a.content !== null && !written.has(a.path) ? previous?.fields?.[a.path] : a.fields;
    } else if (a.type === "unchanged" || ((a.type === "create" || a.type === "update") && written.has(a.path))) {
      fields = specFields(spec);
    } else {
      fields = previous?.fields?.[a.path];
    }
    if (fields && Object.keys(fields).length > 0) out[a.path] = fields;
  }
  return out;
}

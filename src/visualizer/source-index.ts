/**
 * Where each declaration sits in the .at text. The page's Index lens joins
 * these lines to the projection, so a click on a row can jump to its line.
 *
 * The scan follows the parser's own rules for finding a block (`keyword id? {`
 * at the start of a line, `#` comments skipped, `prompt { }` bodies skipped so
 * a line inside a prompt is never read as a declaration), and the first
 * declaration of a name wins. Keys are `<kind>:<id>`; an edge is
 * `edge:<from> -> <to>`.
 *
 * @module
 */

const DECL = /^\s*([a-z][a-z-]*)\s+([A-Za-z][\w-]*)\b[^{]*\{/;
const ARROW = /-x(?:\[[^\]]*\])?->|->/;

/** Ids named by one segment of an arrow chain: `a`, `[a, b]`, optionally followed by an `[attr]`. */
function segmentIds(seg: string): string[] {
  const t = seg.trim();
  if (t.startsWith("[")) {
    const end = t.indexOf("]");
    return t.slice(1, end < 0 ? undefined : end).split(",").map((x) => x.trim()).filter(Boolean);
  }
  const m = /^[A-Za-z][\w-]*/.exec(t);
  return m ? [m[0]] : [];
}

export function sourceIndex(src: string): Record<string, number> {
  const out: Record<string, number> = {};
  const put = (key: string, line: number) => { if (!(key in out)) out[key] = line; };
  const lines = src.split("\n");
  let promptDepth = 0;
  let inFlow = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const ln = i + 1;
    if (promptDepth > 0) {
      for (const ch of line) { if (ch === "{") promptDepth++; else if (ch === "}") promptDepth--; }
      continue;
    }
    if (line.trimStart().startsWith("#")) continue;
    if (/^\s*prompt\s*\{/.test(line)) {
      for (const ch of line.slice(line.indexOf("{"))) { if (ch === "{") promptDepth++; else if (ch === "}") promptDepth--; }
      continue;
    }
    const code = line.replace(/\s#.*$/, "");
    if (/^\s*orchestrator\b[^{]*\{/.test(code)) put("orchestrator:orchestrator", ln);
    const d = DECL.exec(code);
    if (d) put(`${d[1]}:${d[2]}`, ln);
    const dec = /^\s*(?:decisions|decides)\s*:\s*\[([^\]]*)\]/.exec(code);
    if (dec) for (const name of dec[1].split(",").map((x) => x.trim()).filter(Boolean)) put(`decision:${name}`, ln);
    if (/^\s*talk\s*:/.test(code)) put("talk:", ln);
    if (/^\s*flow\s*\{/.test(code)) inFlow = 1;
    else if (inFlow) {
      if (ARROW.test(code)) {
        const segs = code.split(new RegExp(ARROW.source, "g"));
        const groups = segs.map(segmentIds);
        for (let g = 0; g + 1 < groups.length; g++)
          for (const a of groups[g]) for (const b of groups[g + 1]) put(`edge:${a} -> ${b}`, ln);
      }
      for (const ch of code) { if (ch === "{") inFlow++; else if (ch === "}") inFlow--; }
    }
  }
  return out;
}

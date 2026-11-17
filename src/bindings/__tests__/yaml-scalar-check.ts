/**
 * A minimal YAML reader for the frontmatter the binding writes: top-level
 * `key: scalar` lines, `key:` with `  - item` lines below it, and nested
 * blocks (hooks) it skips. Each scalar is read by the YAML 1.2 rules for
 * plain, single-quoted and double-quoted scalars, and a plain scalar YAML
 * would read as something other than a string (a boolean, a number, null, a
 * date) is an error. The package has no YAML library; this is a test aid,
 * not a parser.
 */

/** `notString`: YAML reads the plain scalar as a boolean, number, null or date, not as this text. */
export type Read = { ok: true; value: string; notString?: boolean } | { ok: false; why: string };

/** YAML's indicator characters: a plain scalar cannot start with one (- ? : only before a space or the end). */
const INDICATORS = "-?:,[]{}#&*!|>'\"%@`";

/** Plain scalars a YAML 1.1 or 1.2 loader resolves to something other than a string. */
const NOT_STRING =
  /^(?:~|null|Null|NULL|y|Y|yes|Yes|YES|n|N|no|No|NO|true|True|TRUE|false|False|FALSE|on|On|ON|off|Off|OFF|[-+]?(?:0|[1-9][0-9_]*)|0o?[0-7_]+|0x[0-9a-fA-F_]+|0b[01_]+|[-+]?(?:\d[\d_]*)?\.\d[\d_]*(?:[eE][-+]?\d+)?|[-+]?\d[\d_]*(?:\.\d*)?[eE][-+]?\d+|[-+]?\d[\d_]*\.|[-+]?\.(?:inf|Inf|INF)|\.(?:nan|NaN|NAN)|\d{4}-\d\d?-\d\d?(?:(?:[Tt]|[ \t]+)\d\d?:\d\d:\d\d(?:\.\d*)?(?:[ \t]*(?:Z|[-+]\d\d?(?::\d\d)?))?)?|[-+]?[0-9][0-9_]*(?::[0-5]?[0-9])+(?:\.[0-9_]*)?)$/;

function readDouble(raw: string): Read {
  let out = "";
  let i = 1;
  for (; i < raw.length; i++) {
    const ch = raw[i];
    if (ch === '"') break;
    if (ch.charCodeAt(0) < 0x20 && ch !== "\t") return { ok: false, why: `a control character in a double-quoted scalar` };
    if (ch !== "\\") {
      out += ch;
      continue;
    }
    const e = raw[++i];
    const simple: Record<string, string> = {
      "0": "\0", a: "\x07", b: "\b", t: "\t", "\t": "\t", n: "\n", v: "\v", f: "\f", r: "\r", e: "\x1b",
      " ": " ", '"': '"', "/": "/", "\\": "\\", N: "\u0085", _: "\u00a0", L: "\u2028", P: "\u2029",
    };
    if (e in simple) {
      out += simple[e];
      continue;
    }
    const len = e === "x" ? 2 : e === "u" ? 4 : e === "U" ? 8 : 0;
    if (!len) return { ok: false, why: `an unknown escape \\${e}` };
    const hex = raw.slice(i + 1, i + 1 + len);
    if (!/^[0-9a-fA-F]+$/.test(hex) || hex.length !== len) return { ok: false, why: `a bad \\${e} escape` };
    out += String.fromCodePoint(parseInt(hex, 16));
    i += len;
  }
  if (i >= raw.length) return { ok: false, why: "a double-quoted scalar that does not close" };
  if (raw.slice(i + 1).trim() !== "" && !/^\s+#/.test(raw.slice(i + 1))) return { ok: false, why: "text after a quoted scalar" };
  return { ok: true, value: out };
}

function readSingle(raw: string): Read {
  let out = "";
  let i = 1;
  for (; i < raw.length; i++) {
    if (raw[i] === "'") {
      if (raw[i + 1] === "'") {
        out += "'";
        i++;
        continue;
      }
      break;
    }
    out += raw[i];
  }
  if (i >= raw.length) return { ok: false, why: "a single-quoted scalar that does not close" };
  if (raw.slice(i + 1).trim() !== "" && !/^\s+#/.test(raw.slice(i + 1))) return { ok: false, why: "text after a quoted scalar" };
  return { ok: true, value: out };
}

/** One scalar as YAML reads it in block context (a key's value or a list item). */
export function readScalar(raw: string): Read {
  if (raw.startsWith('"')) return readDouble(raw);
  if (raw.startsWith("'")) return readSingle(raw);
  const first = raw[0];
  if (first !== undefined && INDICATORS.includes(first)) {
    const safeStart = "-?:".includes(first) && raw.length > 1 && !/\s/.test(raw[1]);
    if (!safeStart) return { ok: false, why: `a plain scalar starting with the indicator "${first}"` };
  }
  if (/:(\s|$)/.test(raw)) return { ok: false, why: `": " in a plain scalar starts a mapping` };
  const hash = raw.search(/\s#/);
  const value = (hash === -1 ? raw : raw.slice(0, hash)).trim();
  if (/[\x00-\x08\x0a-\x1f]/.test(value)) return { ok: false, why: "a control character in a plain scalar" };
  if (value === "" || NOT_STRING.test(value)) return { ok: true, value, notString: true };
  return { ok: true, value };
}

/** The top-level keys of a frontmatter block (the text between the fences), each as YAML reads it. */
export type YamlValue = { text: string; notString?: boolean };

export function readFrontmatterYaml(fm: string): { ok: true; fields: Map<string, YamlValue | YamlValue[]> } | { ok: false; why: string } {
  const fields = new Map<string, YamlValue | YamlValue[]>();
  let list: YamlValue[] | null = null;
  let nested = false;
  for (const line of fm.split("\n")) {
    if (line.trim() === "") continue;
    if (/^ {2}- /.test(line) && list) {
      const r = readScalar(line.slice(4));
      if (!r.ok) return { ok: false, why: `${JSON.stringify(line)}: ${r.why}` };
      list.push({ text: r.value, ...(r.notString ? { notString: true } : {}) });
      continue;
    }
    if (/^\s/.test(line)) {
      if (nested) continue;
      return { ok: false, why: `${JSON.stringify(line)}: an indented line that belongs to no block` };
    }
    const m = /^([A-Za-z_][\w-]*):(?: (.*))?$/.exec(line);
    if (!m) return { ok: false, why: `${JSON.stringify(line)}: not a key line` };
    if (fields.has(m[1])) return { ok: false, why: `${m[1]} twice` };
    list = null;
    nested = false;
    if (m[2] === undefined || m[2] === "") {
      list = [];
      fields.set(m[1], list);
      nested = true;
      continue;
    }
    const r = readScalar(m[2]);
    if (!r.ok) return { ok: false, why: `${JSON.stringify(line)}: ${r.why}` };
    fields.set(m[1], { text: r.value, ...(r.notString ? { notString: true } : {}) });
  }
  return { ok: true, fields };
}

/** The frontmatter text of a generated file. */
export function frontmatterOf(content: string): string {
  const m = /^---\n([\s\S]*?)\n---(\n|$)/.exec(content);
  if (!m) throw new Error("no frontmatter");
  return m[1];
}

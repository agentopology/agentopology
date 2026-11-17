/**
 * The keys Claude Code documents, read from its own pages (raw markdown):
 *
 * - settings: https://code.claude.com/docs/en/settings-reference.md, one
 *   `### \`key\`` heading per key with a `* **Type**:` and a `* **Scope**:` line
 * - agent frontmatter: https://code.claude.com/docs/en/sub-agents.md, the
 *   frontmatter table (`| \`key\` | Yes/No | ... |`)
 * - skill frontmatter: https://code.claude.com/docs/en/skills.md, the same
 *   table shape
 *
 * The schema in src/bindings/claude-code-schema.ts is held to what these
 * return: the settings rows are generated from `extractSettingsKeys`, and
 * scripts/claude-code-schema-drift.mjs diffs the frontmatter rows against
 * `extractFrontmatterKeys`.
 *
 * @module
 */

/** The value type of a key, as coarse as the binding needs to write it. */
export type CcValueType = "string" | "boolean" | "number" | "list" | "enum" | "object" | "hooks" | "any";

export interface DocSettingsKey {
  /** The dotted path, as the heading writes it (`permissions.defaultMode`). */
  key: string;
  type: CcValueType;
  /** The allowed values of an enum. */
  values?: string[];
  /** True when a project's `.claude/settings.json` may set the key. */
  projectFile: boolean;
}

/** Read a settings Type line (plus the bullets under it) as a value type. */
function typeOf(typeLine: string, bullets: string[]): { type: CcValueType; values?: string[] } {
  const t = typeLine.trim();
  const quoted = (s: string) => [...s.matchAll(/`"([^"`]+)"`/g)].map((m) => m[1]);
  if (/^Boolean\b/.test(t)) return { type: "boolean" };
  if (/^the string `"[^"]+"`/.test(t)) return { type: "enum", values: quoted(t) };
  // "one of the aliases ..., or a full model ID": any model name, not an enum.
  if (/^string\b/.test(t) && /\bmodel ID\b/.test(t)) return { type: "string" };
  if (/^string, one of\b/.test(t) || /^string, `"[^"]+"` or `"[^"]+"`/.test(t)) {
    // Only the values the sentence lists, not ones a later sentence mentions.
    const inline = [...new Set(quoted(t.split(/\.\s|, which\b/)[0]))];
    const listed = bullets.flatMap((b) => { const m = b.match(/^\s+\* `"([^"`]+)"`/); return m ? [m[1]] : []; });
    const values = inline.length > 0 ? inline : listed;
    return values.length > 0 ? { type: "enum", values } : { type: "string" };
  }
  if (/^string\b/.test(t) && !/\bor array\b/.test(t)) return { type: "string" };
  if (/^(number|integer)\b/.test(t)) return { type: "number" };
  if (/^array\b/.test(t)) return { type: "list" };
  if (/^object keyed by \[hook event\]/.test(t)) return { type: "hooks" };
  if (/^object\b/.test(t)) return { type: "object" };
  return { type: "any" };
}

/** Whether a Scope line lets a project settings file set the key. */
function projectFileOf(scope: string): boolean {
  const s = scope.replace(/\[`?([^`\]]*)`?\]\([^)]*\)/g, "$1").trim();
  return /^Any file\b/i.test(s) || /^[^.]*\bproject\b/i.test(s);
}

/** Every key on the settings reference page that has a Type line. */
export function extractSettingsKeys(markdown: string): DocSettingsKey[] {
  const out: DocSettingsKey[] = [];
  const lines = markdown.split("\n");
  let key: string | null = null;
  let type: string | null = null;
  let scope: string | null = null;
  let bullets: string[] = [];
  let inType = false;
  const flush = () => {
    if (key && type !== null && scope !== null) out.push({ key, ...typeOf(type, bullets), projectFile: projectFileOf(scope) });
    key = null; type = null; scope = null; bullets = []; inType = false;
  };
  for (const line of lines) {
    const h = line.match(/^#{3,5} `([A-Za-z][A-Za-z0-9_.]*)`\s*$/);
    if (h) { flush(); key = h[1]; continue; }
    if (/^#{1,2} /.test(line)) { flush(); continue; }
    if (!key) continue;
    const ty = line.match(/^\* \*\*Type\*\*: (.*)$/);
    if (ty && type === null) { type = ty[1]; inType = true; continue; }
    const sc = line.match(/^\* \*\*Scope\*\*: (.*)$/);
    if (sc && scope === null) { scope = sc[1]; inType = false; continue; }
    if (inType) {
      if (/^\s+\* /.test(line)) bullets.push(line);
      else if (/^\* /.test(line) || line.trim() === "") inType = false;
    }
  }
  flush();
  // A key that is only a value of another key (strictPluginOnlyCustomization.skills) has no own place in the file.
  return out.filter((k) => !(k.type === "enum" && k.values?.length === 1 && out.some((p) => p.key !== k.key && k.key.startsWith(p.key + ".") && p.type === "any")));
}

/** The keys in a frontmatter reference table (`| \`key\` | Yes | ... |`). */
export function extractFrontmatterKeys(markdown: string): string[] {
  const keys = [...markdown.matchAll(/^\| `([A-Za-z][A-Za-z0-9_-]*)` \| (?:Yes|No|Recommended) \|/gm)].map((m) => m[1]);
  return [...new Set(keys)];
}

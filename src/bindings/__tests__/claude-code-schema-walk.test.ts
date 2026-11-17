/**
 * The binding writes no key Claude Code does not know.
 *
 * Scaffold every example (and the kitchen-sink topology, which uses nearly
 * every construct), read every frontmatter block, settings.json and .mcp.json
 * the claude-code binding writes, and look each key up in the schema. A key
 * with no row fails here, naming the file.
 */

import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "../../parser/index.js";
import { validate } from "../../parser/validator.js";
import { claudeCodeBinding } from "../claude-code.js";
import { AT_OWNED_TOPOLOGY_SKILL_KEYS, ccKey, unknownSettingsPaths, type CcSurface } from "../claude-code-schema.js";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const sources = [
  ...fs.readdirSync(join(repo, "examples")).filter((f) => f.endsWith(".at")).map((f) => `examples/${f}`),
  "kitchen-sink.at",
];

/** The top-level keys of a markdown file's frontmatter. */
function frontmatterKeys(md: string): string[] {
  const block = md.match(/^---\n([\s\S]*?)\n---/)?.[1];
  if (!block) return [];
  return [...block.matchAll(/^([A-Za-z_][A-Za-z0-9_-]*):/gm)].map((m) => m[1]);
}

function surfaceOf(path: string): CcSurface | null {
  if (/^\.claude\/agents\/.+\.md$/.test(path)) return "agent";
  if (/^\.claude\/skills\/[^/]+\/SKILL\.md$/.test(path)) return "skill";
  if (/^\.claude\/commands\/.+\.md$/.test(path)) return "command";
  return null;
}

describe("every key the claude-code binding writes has a schema row", () => {
  it.each(sources)("%s", (src) => {
    const ast = parse(fs.readFileSync(join(repo, src), "utf8"));
    const files = claudeCodeBinding.scaffold(ast);
    const unknown: string[] = [];
    for (const f of files) {
      const surface = surfaceOf(f.path);
      if (surface) {
        // The topology's own SKILL.md keeps the keys import reads (the one named exception).
        const allow = f.path === `.claude/skills/${ast.topology.name}/SKILL.md` ? AT_OWNED_TOPOLOGY_SKILL_KEYS : [];
        for (const k of frontmatterKeys(f.content)) if (!ccKey(surface, k) && !allow.includes(k)) unknown.push(`${f.path}: ${k}`);
      } else if (f.path === ".claude/settings.json") {
        for (const k of unknownSettingsPaths(JSON.parse(f.content))) unknown.push(`${f.path}: ${k}`);
      } else if (f.path === ".mcp.json") {
        const servers = JSON.parse(f.content).mcpServers as Record<string, Record<string, unknown>>;
        for (const [name, entry] of Object.entries(servers))
          for (const k of Object.keys(entry)) if (!ccKey("mcp-server", k)) unknown.push(`${f.path}: ${name}.${k}`);
      }
    }
    expect(unknown).toEqual([]);
    // And no claude-code extension key in the .at goes unwritten.
    expect(validate(ast).filter((r) => r.rule === "V130" && /extensions \{ claude-code \{/.test(r.message)).map((r) => r.message)).toEqual([]);
  });
});

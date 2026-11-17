/**
 * A file's frontmatter as the .at would state it.
 *
 * Import reads some values only in part (a block-scalar description comes in
 * as "|", a flow list with quotes as broken items), and the .at text it
 * writes can lose a little more on the way back in. If scaffold compared the
 * .at with the file's literal value, the first run after an import would take
 * every such value as "changed by the .at" and write the partial reading over
 * the user's text. So it compares with the file taken the whole way the .at
 * took it: read as import reads it, written into .at text, parsed back, and
 * rendered as the binding writes it. A key the .at did not change compares
 * equal, whatever import made of it.
 *
 * @module
 */

import type { AgentNode, SkillDef, TopologyAST, TriggerDef } from "../parser/ast.js";
import type { StructureSpec } from "../bindings/types.js";
import { generatedFileFor } from "../bindings/claude-code.js";
import { parseAgentMd, parseCommandMd, skillFromMd } from "../import/claude-code.js";
import { serializeAST } from "../import/serializer.js";
import { parse } from "../parser/index.js";
import { readFrontmatter, type FieldValue } from "./frontmatter-patch.js";

/** The node as it comes back from .at text: through the serializer and the parser. */
function throughAt(ast: TopologyAST, part: Partial<TopologyAST>): TopologyAST {
  const one: TopologyAST = { ...ast, nodes: [], edges: [], skills: [], triggers: [], ...part };
  return parse(serializeAST(one));
}

/** The file's frontmatter values as the .at would state them; null when that cannot be said. */
export function echoFields(ast: TopologyAST, spec: StructureSpec, text: string): Record<string, FieldValue> | null {
  try {
    let content: string | null = null;
    if (spec.kind === "agent") {
      const read = parseAgentMd(spec.id, text);
      if (!read || read.type !== "agent") return null;
      // Import cannot know invocation from the file; the binding's manual-use
      // sentence must not be added on top of a description that holds it.
      const back = throughAt(ast, { nodes: [{ ...read, invocation: undefined }] });
      const node = back.nodes.find((n) => n.id === spec.id && n.type === "agent") as AgentNode | undefined;
      if (!node) return null;
      content = generatedFileFor(ast, { kind: "agent", node: { ...node, invocation: undefined } });
    } else if (spec.kind === "skill") {
      const back = throughAt(ast, { skills: [skillFromMd(spec.id, text)] });
      const skill = back.skills.find((s) => s.id === spec.id) as SkillDef | undefined;
      if (!skill) return null;
      content = generatedFileFor(ast, { kind: "skill", node: skill });
    } else {
      const read = parseCommandMd(`${spec.id}.md`, text);
      if (!read) return null;
      const back = throughAt(ast, { triggers: [read] });
      const trigger = back.triggers.find((t) => t.name === spec.id) as TriggerDef | undefined;
      if (!trigger) return null;
      content = generatedFileFor(ast, { kind: "command", node: trigger });
    }
    if (content === null) return null;
    const fm = readFrontmatter(content);
    if (!fm.ok) return null;
    return Object.fromEntries([...fm.fields].map(([k, f]) => [k, f.value]));
  } catch {
    return null;
  }
}

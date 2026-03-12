#!/usr/bin/env npx tsx
/**
 * emit.ts — Generate valid AgentTopology (.at) files from structured JSON input.
 *
 * Usage:
 *   echo '{"topology":...}' | npx tsx emit.ts              # stdin -> stdout
 *   npx tsx emit.ts input.json                              # file -> stdout
 *   npx tsx emit.ts input.json output.at                    # file -> file
 */

import * as fs from "fs";
import * as path from "path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface TopologyInput {
  topology: {
    name: string;
    version: string;
    description: string;
    patterns: string[];
    foundations?: string[];
    advanced?: string[];
  };
  nodes: Array<NodeInput>;
  edges: Array<EdgeInput>;
  orchestrator?: {
    model: string;
    generates?: string;
    handles: string[];
    outputs?: Record<string, string[]>;
  };
  roles?: Record<string, string>;
  memory?: Record<string, Record<string, any>>;
  triggers?: Array<{ name: string; pattern: string; argument?: string }>;
  hooks?: Array<{ name: string; on: string; matcher?: string; run: string; type?: string }>;
  settings?: { allow?: string[]; deny?: string[]; ask?: string[] };
  mcpServers?: Record<string, { type: string; url?: string; command?: string; args?: string[]; env?: Record<string, string> }>;
  providers?: Array<{ name: string; apiKey?: string; baseUrl?: string; models: string[]; default?: boolean; extra?: Record<string, unknown> }>;
}

interface NodeInput {
  id: string;
  type: "agent" | "action" | "gate" | "orchestrator";
  label?: string;
  model?: string;
  permissions?: string;
  prompt?: string;
  phase?: number;
  tools?: string[];
  disallowedTools?: string[];
  reads?: string[];
  writes?: string[];
  outputs?: Record<string, string[]>;
  skip?: string;
  retry?: number;
  isolation?: string;
  invocation?: string;
  behavior?: string;
  role?: string;
  memory?: string;
  skills?: string[];
  mcpServers?: string[];
  background?: boolean;
  hooks?: Array<{ name: string; on: string; matcher?: string; run: string; type?: string; timeout?: number }>;
  // action fields
  kind?: string;
  source?: string;
  commands?: string[];
  description?: string;
  // gate fields
  after?: string;
  before?: string;
  run?: string;
  checks?: string[];
  onFail?: string;
}

interface EdgeInput {
  from: string;
  to: string | string[];
  condition?: string | null;
  maxIterations?: number | null;
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

const I = "  "; // 2-space indent

/** Wrap a value in quotes. */
function quoteStr(s: string): string {
  return `"${s}"`;
}

/** Check if a value looks like an identifier (lowercase, hyphens, starts with letter). */
function isIdentifier(s: string): boolean {
  return /^[a-z][a-z0-9-]*$/.test(s);
}

/** Check if a value looks like a template-var (uppercase). */
function isTemplateVar(s: string): boolean {
  return /^[A-Z][A-Z0-9_-]*$/.test(s);
}

/** Format a value — identifiers and booleans/numbers unquoted, strings quoted. */
function fmtValue(v: string | number | boolean): string {
  if (typeof v === "number") return String(v);
  if (typeof v === "boolean") return String(v);
  if (v === "true" || v === "false") return v;
  if (isIdentifier(v)) return v;
  if (isTemplateVar(v)) return v;
  // Numbers as strings
  if (/^[0-9]+(\.[0-9]+)?$/.test(v)) return v;
  return quoteStr(v);
}

/**
 * Format a list — single line if total width <= maxWidth, multi-line otherwise.
 * maxWidth defaults to 90 (comfortable .at line width).
 */
function fmtList(
  items: string[],
  indent: string,
  maxWidth: number = 90,
  formatter: (s: string) => string = fmtValue as (s: string) => string,
): string {
  if (items.length === 0) return "[]";
  const formatted = items.map(formatter);
  const singleLine = `[${formatted.join(", ")}]`;
  if (singleLine.length <= maxWidth) {
    return singleLine;
  }
  const inner = formatted.map((f) => `${indent}${I}${f}`).join(",\n");
  return `[\n${inner}\n${indent}]`;
}

/** Format a string list (always quoted). */
function fmtStringList(items: string[], indent: string, maxWidth: number = 90): string {
  return fmtList(items, indent, maxWidth, quoteStr);
}

/** Format a tool item — core tools unquoted, mcp.* unquoted, Bash("x") unquoted. */
function fmtToolItem(t: string): string {
  // Already formatted like Read, Write, Bash("pattern"), mcp.gitnexus.*
  return t;
}

/**
 * Categorize and sort tools: core tools first, then Bash patterns, then mcp.* grouped by server.
 */
function sortTools(tools: string[]): string[] {
  const coreOrder = ["Read", "Write", "Edit", "Bash", "Glob", "Grep", "Agent"];
  const core: string[] = [];
  const bashPatterns: string[] = [];
  const mcp: string[] = [];

  for (const t of tools) {
    if (t.startsWith("mcp.")) {
      mcp.push(t);
    } else if (t.startsWith("Bash(")) {
      bashPatterns.push(t);
    } else {
      core.push(t);
    }
  }

  // Sort core by canonical order
  core.sort((a, b) => {
    const ai = coreOrder.indexOf(a);
    const bi = coreOrder.indexOf(b);
    if (ai === -1 && bi === -1) return a.localeCompare(b);
    if (ai === -1) return 1;
    if (bi === -1) return -1;
    return ai - bi;
  });

  // Sort MCP by server name, then tool name
  mcp.sort((a, b) => a.localeCompare(b));

  return [...core, ...bashPatterns, ...mcp];
}

/**
 * Format tool list with smart grouping — groups tools by category on the same line.
 * Core tools on one line, then each MCP server's tools on one line.
 */
function fmtToolList(tools: string[], indent: string): string {
  if (tools.length === 0) return "[]";
  const sorted = sortTools(tools);
  // If 4 or fewer, single line
  if (sorted.length <= 4) {
    return `[${sorted.map(fmtToolItem).join(", ")}]`;
  }

  // Group: core tools, bash patterns, then MCP tools grouped by server
  const core: string[] = [];
  const bashPatterns: string[] = [];
  const mcpGroups = new Map<string, string[]>();

  for (const t of sorted) {
    if (t.startsWith("mcp.")) {
      // Group by server: mcp.<server>.* or mcp.<server>.<tool>
      const parts = t.split(".");
      const server = parts[1];
      const group = mcpGroups.get(server) || [];
      group.push(t);
      mcpGroups.set(server, group);
    } else if (t.startsWith("Bash(")) {
      bashPatterns.push(t);
    } else {
      core.push(t);
    }
  }

  // Build rows: core on one line, each MCP server on one line
  const rows: string[] = [];
  if (core.length > 0) {
    const coreLine = core.join(", ");
    if (bashPatterns.length > 0) {
      rows.push(coreLine + ",");
      rows.push(bashPatterns.join(", "));
    } else {
      rows.push(coreLine);
    }
  } else if (bashPatterns.length > 0) {
    rows.push(bashPatterns.join(", "));
  }

  const serverNames = Array.from(mcpGroups.keys()).sort();
  for (const server of serverNames) {
    const serverTools = mcpGroups.get(server)!;
    rows.push(serverTools.join(", "));
  }

  // Check if the whole thing fits on one line
  const allItems = sorted.map(fmtToolItem).join(", ");
  const singleLine = `[${allItems}]`;
  if (singleLine.length <= 90) {
    return singleLine;
  }

  // Multi-line with grouped rows
  const lines: string[] = [];
  lines.push("[");
  for (let i = 0; i < rows.length; i++) {
    const isLast = i === rows.length - 1;
    const row = rows[i];
    // If row doesn't end with comma and isn't last, add comma
    if (!isLast && !row.endsWith(",")) {
      lines.push(`${indent}${I}${row},`);
    } else {
      lines.push(`${indent}${I}${row}`);
    }
  }
  lines.push(`${indent}]`);
  return lines.join("\n");
}

/** Format path-list — items are quoted except `ticket` keyword. */
function fmtPathList(items: string[], indent: string): string {
  if (items.length === 0) return "[]";
  const formatted = items.map((item) => (item === "ticket" ? "ticket" : quoteStr(item)));
  const singleLine = `[${formatted.join(", ")}]`;
  if (singleLine.length <= 90) {
    return singleLine;
  }
  const inner = formatted.map((f) => `${indent}${I}${f}`).join(",\n");
  return `[\n${inner}\n${indent}]`;
}

/** Format typed-map outputs block. */
function fmtOutputs(outputs: Record<string, string[]>, indent: string): string {
  const entries = Object.entries(outputs);
  if (entries.length === 0) return "{}";
  const lines: string[] = [];
  lines.push("{");
  for (const [key, values] of entries) {
    lines.push(`${indent}${I}${key}: ${values.join(" | ")}`);
  }
  lines.push(`${indent}}`);
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Section emitters
// ---------------------------------------------------------------------------

function emitMeta(input: TopologyInput): string[] {
  const lines: string[] = [];
  lines.push(`${I}meta {`);
  lines.push(`${I}${I}version: ${quoteStr(input.topology.version)}`);
  lines.push(`${I}${I}description: ${quoteStr(input.topology.description)}`);
  if (input.topology.foundations && input.topology.foundations.length > 0) {
    lines.push(`${I}${I}foundations: ${fmtList(input.topology.foundations, `${I}${I}`)}`);
  }
  if (input.topology.advanced && input.topology.advanced.length > 0) {
    lines.push(`${I}${I}advanced: ${fmtList(input.topology.advanced, `${I}${I}`)}`);
  }
  lines.push(`${I}}`);
  return lines;
}

function emitOrchestrator(input: TopologyInput): string[] {
  if (!input.orchestrator) return [];
  const o = input.orchestrator;
  const lines: string[] = [];
  lines.push(`${I}orchestrator {`);
  lines.push(`${I}${I}model: ${o.model}`);
  if (o.generates) {
    lines.push(`${I}${I}generates: ${quoteStr(o.generates)}`);
  }
  lines.push(`${I}${I}handles: ${fmtList(o.handles, `${I}${I}`)}`);
  if (o.outputs && Object.keys(o.outputs).length > 0) {
    lines.push(`${I}${I}outputs: ${fmtOutputs(o.outputs, `${I}${I}`)}`);
  }
  lines.push(`${I}}`);
  return lines;
}

function emitRoles(input: TopologyInput): string[] {
  if (!input.roles || Object.keys(input.roles).length === 0) return [];
  const lines: string[] = [];
  lines.push(`${I}roles {`);
  for (const [name, desc] of Object.entries(input.roles)) {
    lines.push(`${I}${I}${name}: ${quoteStr(desc)}`);
  }
  lines.push(`${I}}`);
  return lines;
}

function emitActions(nodes: NodeInput[]): string[] {
  const actions = nodes.filter((n) => n.type === "action");
  if (actions.length === 0) return [];
  const lines: string[] = [];
  lines.push(`${I}# --- Actions (orchestrator-handled steps) ---`);
  for (const action of actions) {
    lines.push("");
    lines.push(`${I}action ${action.id} {`);
    if (action.kind) {
      lines.push(`${I}${I}kind: ${action.kind}`);
    }
    if (action.source) {
      lines.push(`${I}${I}source: ${quoteStr(action.source)}`);
    }
    if (action.commands && action.commands.length > 0) {
      lines.push(`${I}${I}commands: ${fmtList(action.commands, `${I}${I}`)}`);
    }
    if (action.description) {
      lines.push(`${I}${I}description: ${quoteStr(action.description)}`);
    }
    lines.push(`${I}}`);
  }
  return lines;
}

function emitAgent(node: NodeInput, indent: string): string[] {
  const lines: string[] = [];
  if (node.model) lines.push(`${indent}model: ${node.model}`);
  if (node.permissions && node.permissions !== "auto") {
    lines.push(`${indent}permissions: ${node.permissions}`);
  }
  if (node.prompt) {
    lines.push(`${indent}prompt {`);
    // Indent each line of the prompt content
    for (const promptLine of node.prompt.split("\n")) {
      if (promptLine.trim()) {
        lines.push(`${indent}${I}${promptLine}`);
      } else {
        lines.push("");
      }
    }
    lines.push(`${indent}}`);
  }
  if (node.phase !== undefined && node.phase !== null) {
    lines.push(`${indent}phase: ${node.phase}`);
  }
  if (node.disallowedTools && node.disallowedTools.length > 0) {
    lines.push(`${indent}disallowed-tools: ${fmtToolList(node.disallowedTools, indent)}`);
  }
  if (node.tools && node.tools.length > 0) {
    lines.push(`${indent}tools: ${fmtToolList(node.tools, indent)}`);
  }
  if (node.reads && node.reads.length > 0) {
    lines.push(`${indent}reads: ${fmtPathList(node.reads, indent)}`);
  }
  if (node.writes && node.writes.length > 0) {
    lines.push(`${indent}writes: ${fmtPathList(node.writes, indent)}`);
  }
  if (node.outputs && Object.keys(node.outputs).length > 0) {
    lines.push(`${indent}outputs: ${fmtOutputs(node.outputs, indent)}`);
  }
  if (node.skip) lines.push(`${indent}skip: ${node.skip}`);
  if (node.retry && node.retry > 0) lines.push(`${indent}retry: ${node.retry}`);
  if (node.isolation) lines.push(`${indent}isolation: ${node.isolation}`);
  if (node.behavior && node.behavior !== "blocking") {
    lines.push(`${indent}behavior: ${node.behavior}`);
  }
  if (node.invocation && node.invocation !== "auto") {
    lines.push(`${indent}invocation: ${node.invocation}`);
  }
  if (node.role) lines.push(`${indent}role: ${node.role}`);
  if (node.memory) lines.push(`${indent}memory: ${node.memory}`);
  if (node.skills && node.skills.length > 0) {
    lines.push(`${indent}skills: ${fmtList(node.skills, indent)}`);
  }
  if (node.mcpServers && node.mcpServers.length > 0) {
    lines.push(`${indent}mcp-servers: ${fmtList(node.mcpServers, indent)}`);
  }
  if (node.background === true) lines.push(`${indent}background: true`);
  // Per-agent hooks
  if (node.hooks && node.hooks.length > 0) {
    lines.push(`${indent}hooks {`);
    for (let i = 0; i < node.hooks.length; i++) {
      const h = node.hooks[i];
      if (i > 0) lines.push("");
      lines.push(`${indent}${I}hook ${h.name} {`);
      lines.push(`${indent}${I}${I}on: ${h.on}`);
      if (h.matcher) lines.push(`${indent}${I}${I}matcher: ${quoteStr(h.matcher)}`);
      lines.push(`${indent}${I}${I}run: ${quoteStr(h.run)}`);
      if (h.type) lines.push(`${indent}${I}${I}type: ${h.type}`);
      if (h.timeout && h.timeout !== 600) lines.push(`${indent}${I}${I}timeout: ${h.timeout}`);
      lines.push(`${indent}${I}}`);
    }
    lines.push(`${indent}}`);
  }
  return lines;
}

function emitAgents(nodes: NodeInput[]): string[] {
  const agents = nodes.filter((n) => n.type === "agent");
  if (agents.length === 0) return [];
  const lines: string[] = [];
  lines.push(`${I}# --- Agents ---`);

  // Sort agents by phase (undefined phase goes last), then by id
  const sorted = [...agents].sort((a, b) => {
    const ap = a.phase ?? 999;
    const bp = b.phase ?? 999;
    if (ap !== bp) return ap - bp;
    return a.id.localeCompare(b.id);
  });

  for (const agent of sorted) {
    lines.push("");
    lines.push(`${I}agent ${agent.id} {`);
    lines.push(...emitAgent(agent, `${I}${I}`));
    lines.push(`${I}}`);
  }
  return lines;
}

function emitMemory(memory: Record<string, Record<string, any>> | undefined): string[] {
  if (!memory || Object.keys(memory).length === 0) return [];
  const lines: string[] = [];
  lines.push(`${I}# --- Memory (Blackboard) ---`);
  lines.push("");
  lines.push(`${I}memory {`);

  const blockNames = Object.keys(memory);
  for (let i = 0; i < blockNames.length; i++) {
    const name = blockNames[i];
    const block = memory[name];
    if (i > 0) lines.push("");
    lines.push(`${I}${I}${name} {`);
    for (const [key, value] of Object.entries(block)) {
      if (Array.isArray(value)) {
        // Check if items look like identifiers or strings
        const allIdentifiers = value.every((v: any) => typeof v === "string" && isIdentifier(v));
        if (allIdentifiers) {
          lines.push(`${I}${I}${I}${key}: ${fmtList(value, `${I}${I}${I}`)}`);
        } else {
          lines.push(`${I}${I}${I}${key}: ${fmtStringList(value, `${I}${I}${I}`)}`);
        }
      } else if (typeof value === "string") {
        if (isIdentifier(value)) {
          lines.push(`${I}${I}${I}${key}: ${value}`);
        } else {
          lines.push(`${I}${I}${I}${key}: ${quoteStr(value)}`);
        }
      } else {
        lines.push(`${I}${I}${I}${key}: ${fmtValue(value)}`);
      }
    }
    lines.push(`${I}${I}}`);
  }
  lines.push(`${I}}`);
  return lines;
}

function emitFlow(edges: EdgeInput[]): string[] {
  if (edges.length === 0) return [];
  const lines: string[] = [];
  lines.push(`${I}# --- Flow ---`);
  lines.push("");
  lines.push(`${I}flow {`);

  // Build chain-merged flow statements.
  // Detect sequences of unconditional edges (a->b, b->c) and merge into a->b->c.
  // Only merge when both edges are unconditional, single-target, and the intermediate
  // node has exactly one unconditional incoming and one unconditional outgoing edge.
  type FlowStmt = { chain: string[]; condition?: string; maxIterations?: number };
  const stmts: FlowStmt[] = [];

  // Index: for each node, which unconditional edges go out?
  const unconditionalOutgoing = new Map<string, EdgeInput[]>();
  const unconditionalIncoming = new Map<string, EdgeInput[]>();
  for (const e of edges) {
    if (!e.condition && !Array.isArray(e.to)) {
      const list = unconditionalOutgoing.get(e.from) || [];
      list.push(e);
      unconditionalOutgoing.set(e.from, list);
      const inList = unconditionalIncoming.get(e.to as string) || [];
      inList.push(e);
      unconditionalIncoming.set(e.to as string, inList);
    }
  }

  // Track which edges have been consumed by chaining
  const consumed = new Set<number>();

  for (let i = 0; i < edges.length; i++) {
    if (consumed.has(i)) continue;
    const edge = edges[i];

    // Try to build a chain starting from this edge (only for unconditional single-target edges)
    if (!edge.condition && !edge.maxIterations && !Array.isArray(edge.to)) {
      const chain = [edge.from, edge.to as string];
      consumed.add(i);

      // Extend chain: look for the next edge starting from chain's tail
      let extended = true;
      while (extended) {
        extended = false;
        const tail = chain[chain.length - 1];
        // Only chain if tail has exactly one unconditional outgoing and one unconditional incoming
        const outEdges = unconditionalOutgoing.get(tail) || [];
        const inEdges = unconditionalIncoming.get(tail) || [];
        if (outEdges.length === 1 && inEdges.length === 1) {
          const nextEdge = outEdges[0];
          const nextIdx = edges.indexOf(nextEdge);
          if (nextIdx >= 0 && !consumed.has(nextIdx) && !nextEdge.condition && !nextEdge.maxIterations && !Array.isArray(nextEdge.to)) {
            chain.push(nextEdge.to as string);
            consumed.add(nextIdx);
            extended = true;
          }
        }
      }

      stmts.push({ chain });
    } else {
      // Conditional or fan-out edge — emit directly
      consumed.add(i);
      const to = Array.isArray(edge.to) ? edge.to : [edge.to];
      stmts.push({
        chain: [edge.from, ...(Array.isArray(edge.to) ? [] : to)],
        condition: edge.condition || undefined,
        maxIterations: edge.maxIterations || undefined,
        // For fan-out, store the array
        ...(Array.isArray(edge.to) ? { _fanOut: edge.to } : {}),
      });
    }
  }

  // Format flow lines
  const flowLines: Array<{ text: string; attrs: string }> = [];
  for (const stmt of stmts) {
    const s = stmt as any;
    let base: string;
    if (s._fanOut) {
      base = `${stmt.chain[0]} -> [${s._fanOut.join(", ")}]`;
    } else {
      base = stmt.chain.join(" -> ");
    }

    const attrs: string[] = [];
    if (stmt.condition) {
      attrs.push(`when ${stmt.condition}`);
    }
    if (stmt.maxIterations) {
      attrs.push(`max ${stmt.maxIterations}`);
    }

    flowLines.push({ text: base, attrs: attrs.length > 0 ? `[${attrs.join(", ")}]` : "" });
  }

  // Calculate alignment column for conditions
  const condLines = flowLines.filter((f) => f.attrs);
  const maxBase = condLines.length > 0 ? Math.max(...condLines.map((f) => f.text.length)) : 0;
  const alignCol = maxBase + 2;

  for (const fl of flowLines) {
    if (fl.attrs) {
      const padded = fl.text.padEnd(alignCol);
      lines.push(`${I}${I}${padded}${fl.attrs}`);
    } else {
      lines.push(`${I}${I}${fl.text}`);
    }
  }

  lines.push(`${I}}`);
  return lines;
}

function emitGates(nodes: NodeInput[]): string[] {
  const gates = nodes.filter((n) => n.type === "gate");
  if (gates.length === 0) return [];
  const lines: string[] = [];
  lines.push(`${I}# --- Gates ---`);
  lines.push("");
  lines.push(`${I}gates {`);
  for (let i = 0; i < gates.length; i++) {
    const gate = gates[i];
    if (i > 0) lines.push("");
    lines.push(`${I}${I}gate ${gate.id} {`);
    if (gate.after) lines.push(`${I}${I}${I}after: ${gate.after}`);
    if (gate.before) lines.push(`${I}${I}${I}before: ${gate.before}`);
    if (gate.run) lines.push(`${I}${I}${I}run: ${quoteStr(gate.run)}`);
    if (gate.checks && gate.checks.length > 0) {
      lines.push(`${I}${I}${I}checks: ${fmtList(gate.checks, `${I}${I}${I}`)}`);
    }
    if (gate.retry && gate.retry > 0) {
      lines.push(`${I}${I}${I}retry: ${gate.retry}`);
    }
    if (gate.onFail) {
      lines.push(`${I}${I}${I}on-fail: ${gate.onFail}`);
    }
    if (gate.behavior && gate.behavior !== "blocking") {
      lines.push(`${I}${I}${I}behavior: ${gate.behavior}`);
    }
    lines.push(`${I}${I}}`);
  }
  lines.push(`${I}}`);
  return lines;
}

function emitTriggers(triggers: TopologyInput["triggers"]): string[] {
  if (!triggers || triggers.length === 0) return [];
  const lines: string[] = [];
  lines.push(`${I}# --- Triggers ---`);
  lines.push("");
  lines.push(`${I}triggers {`);
  for (let i = 0; i < triggers.length; i++) {
    const t = triggers[i];
    if (i > 0) lines.push("");
    lines.push(`${I}${I}command ${t.name} {`);
    lines.push(`${I}${I}${I}pattern: ${quoteStr(t.pattern)}`);
    if (t.argument) {
      lines.push(`${I}${I}${I}argument: ${t.argument}`);
    }
    lines.push(`${I}${I}}`);
  }
  lines.push(`${I}}`);
  return lines;
}

function emitHooks(hooks: TopologyInput["hooks"]): string[] {
  if (!hooks || hooks.length === 0) return [];
  const lines: string[] = [];
  lines.push(`${I}# --- Hooks ---`);
  lines.push("");
  lines.push(`${I}hooks {`);
  for (let i = 0; i < hooks.length; i++) {
    const h = hooks[i];
    if (i > 0) lines.push("");
    lines.push(`${I}${I}hook ${h.name} {`);
    lines.push(`${I}${I}${I}on: ${h.on}`);
    if (h.matcher) lines.push(`${I}${I}${I}matcher: ${quoteStr(h.matcher)}`);
    lines.push(`${I}${I}${I}run: ${quoteStr(h.run)}`);
    if (h.type) lines.push(`${I}${I}${I}type: ${h.type}`);
    lines.push(`${I}${I}}`);
  }
  lines.push(`${I}}`);
  return lines;
}

function emitSettings(settings: TopologyInput["settings"]): string[] {
  if (!settings) return [];
  const has = (settings.allow && settings.allow.length > 0)
    || (settings.deny && settings.deny.length > 0)
    || (settings.ask && settings.ask.length > 0);
  if (!has) return [];
  const lines: string[] = [];
  lines.push(`${I}# --- Settings ---`);
  lines.push("");
  lines.push(`${I}settings {`);
  if (settings.allow && settings.allow.length > 0) {
    lines.push(`${I}${I}allow: ${fmtStringList(settings.allow, `${I}${I}`)}`);
  }
  if (settings.deny !== undefined) {
    if (settings.deny.length === 0) {
      lines.push(`${I}${I}deny: []`);
    } else {
      lines.push(`${I}${I}deny: ${fmtStringList(settings.deny, `${I}${I}`)}`);
    }
  }
  if (settings.ask !== undefined) {
    if (settings.ask.length === 0) {
      lines.push(`${I}${I}ask: []`);
    } else {
      lines.push(`${I}${I}ask: ${fmtStringList(settings.ask, `${I}${I}`)}`);
    }
  }
  lines.push(`${I}}`);
  return lines;
}

function emitMcpServers(servers: TopologyInput["mcpServers"]): string[] {
  if (!servers || Object.keys(servers).length === 0) return [];
  const lines: string[] = [];
  lines.push(`${I}# --- MCP Servers ---`);
  lines.push("");
  lines.push(`${I}mcp-servers {`);
  const names = Object.keys(servers);
  for (let i = 0; i < names.length; i++) {
    const name = names[i];
    const srv = servers[name];
    if (i > 0) lines.push("");
    lines.push(`${I}${I}${name} {`);
    lines.push(`${I}${I}${I}type: ${srv.type}`);
    if (srv.url) lines.push(`${I}${I}${I}url: ${quoteStr(srv.url)}`);
    if (srv.command) lines.push(`${I}${I}${I}command: ${quoteStr(srv.command)}`);
    if (srv.args && srv.args.length > 0) {
      lines.push(`${I}${I}${I}args: ${fmtStringList(srv.args, `${I}${I}${I}`)}`);
    }
    if (srv.env && Object.keys(srv.env).length > 0) {
      lines.push(`${I}${I}${I}env: {`);
      for (const [k, v] of Object.entries(srv.env)) {
        lines.push(`${I}${I}${I}${I}${k}: ${quoteStr(v)}`);
      }
      lines.push(`${I}${I}${I}}`);
    }
    lines.push(`${I}${I}}`);
  }
  lines.push(`${I}}`);
  return lines;
}

function emitProviders(providers: TopologyInput["providers"]): string[] {
  if (!providers || providers.length === 0) return [];
  const lines: string[] = [];
  lines.push(`${I}# --- Providers ---`);
  lines.push("");
  lines.push(`${I}providers {`);
  for (let i = 0; i < providers.length; i++) {
    const p = providers[i];
    if (i > 0) lines.push("");
    lines.push(`${I}${I}${p.name} {`);
    if (p.apiKey) lines.push(`${I}${I}${I}api-key: ${quoteStr(p.apiKey)}`);
    if (p.baseUrl) lines.push(`${I}${I}${I}base-url: ${quoteStr(p.baseUrl)}`);
    if (p.models && p.models.length > 0) {
      lines.push(`${I}${I}${I}models: ${fmtList(p.models, `${I}${I}${I}`)}`);
    }
    if (p.default === true) lines.push(`${I}${I}${I}default: true`);
    if (p.extra) {
      for (const [key, value] of Object.entries(p.extra)) {
        lines.push(`${I}${I}${I}${key}: ${fmtValue(value as string | number | boolean)}`);
      }
    }
    lines.push(`${I}${I}}`);
  }
  lines.push(`${I}}`);
  return lines;
}

// ---------------------------------------------------------------------------
// Main emitter
// ---------------------------------------------------------------------------

function emit(input: TopologyInput): string {
  const sections: string[][] = [];

  // Header comment
  const header = [
    `# ${input.topology.name}.at — ${input.topology.description}`,
    `# AgentTopology v1.0`,
  ];

  // Topology declaration
  const patterns = input.topology.patterns.join(", ");
  const topOpen = `topology ${input.topology.name} : [${patterns}] {`;

  // Build sections in canonical order
  sections.push(emitMeta(input));
  sections.push(emitOrchestrator(input));
  sections.push(emitRoles(input));
  sections.push(emitActions(input.nodes));
  sections.push(emitAgents(input.nodes));
  sections.push(emitMemory(input.memory));
  sections.push(emitFlow(input.edges));
  sections.push(emitGates(input.nodes));
  sections.push(emitTriggers(input.triggers));
  sections.push(emitHooks(input.hooks));
  sections.push(emitProviders(input.providers));
  sections.push(emitSettings(input.settings));
  sections.push(emitMcpServers(input.mcpServers));

  // Assemble
  const parts: string[] = [];
  parts.push(header.join("\n"));
  parts.push("");
  parts.push(topOpen);

  for (const section of sections) {
    if (section.length === 0) continue;
    parts.push("");
    parts.push(section.join("\n"));
  }

  parts.push("}");
  parts.push(""); // trailing newline

  return parts.join("\n");
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  let jsonStr: string;

  if (process.argv[2]) {
    // Read from file
    const inputPath = path.resolve(process.argv[2]);
    jsonStr = fs.readFileSync(inputPath, "utf-8");
  } else {
    // Read from stdin
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) {
      chunks.push(chunk as Buffer);
    }
    jsonStr = Buffer.concat(chunks).toString("utf-8");
  }

  const input: TopologyInput = JSON.parse(jsonStr);
  const output = emit(input);

  if (process.argv[3]) {
    const outputPath = path.resolve(process.argv[3]);
    fs.writeFileSync(outputPath, output, "utf-8");
  } else {
    process.stdout.write(output);
  }
}

main().catch((err) => {
  console.error("emit.ts error:", err.message);
  process.exit(1);
});

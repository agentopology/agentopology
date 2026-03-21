/**
 * Topology analyzer — detects patterns, computes layers, and suggests improvements.
 *
 * @module
 */

import type {
  TopologyAST,
  NodeDef,
  EdgeDef,
  AgentNode,
  GateNode,
  HumanNode,
  GroupNode,
} from "../parser/ast.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface TopologySummary {
  name: string;
  version: string;
  description: string;
  nodeCount: {
    agents: number;
    actions: number;
    gates: number;
    groups: number;
    humans: number;
    orchestrators: number;
    stores: number;
  };
  edgeCount: number;
  declaredPatterns: string[];
}

export interface DetectedPattern {
  name: string;
  confidence: "definite" | "likely";
  involvedNodes: string[];
  description: string;
}

export interface LayerInfo {
  depth: number;
  nodes: string[];
}

export interface Suggestion {
  level: "info" | "improvement";
  message: string;
  node?: string;
}

export interface AnalysisResult {
  summary: TopologySummary;
  patterns: DetectedPattern[];
  layers: LayerInfo[];
  suggestions: Suggestion[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isAgent(n: NodeDef): n is AgentNode {
  return n.type === "agent";
}

function isGate(n: NodeDef): n is GateNode {
  return n.type === "gate";
}

/** Compute in-degree and out-degree for each node in the flow graph. */
function computeDegrees(edges: EdgeDef[]): Map<string, { in: number; out: number }> {
  const degrees = new Map<string, { in: number; out: number }>();

  const ensure = (id: string) => {
    if (!degrees.has(id)) degrees.set(id, { in: 0, out: 0 });
  };

  for (const edge of edges) {
    ensure(edge.from);
    ensure(edge.to);
    degrees.get(edge.from)!.out++;
    degrees.get(edge.to)!.in++;
  }

  return degrees;
}

/** Build adjacency list from edges. */
function buildAdjacency(edges: EdgeDef[]): Map<string, string[]> {
  const adj = new Map<string, string[]>();
  for (const edge of edges) {
    if (!adj.has(edge.from)) adj.set(edge.from, []);
    adj.get(edge.from)!.push(edge.to);
  }
  return adj;
}

// ---------------------------------------------------------------------------
// Layer computation (Kahn's algorithm)
// ---------------------------------------------------------------------------

function computeLayers(edges: EdgeDef[], nodeIds: Set<string>): LayerInfo[] {
  // Only consider forward edges (no back-edges with maxIterations)
  const forwardEdges = edges.filter((e) => !e.maxIterations);

  const inDegree = new Map<string, number>();
  const adj = new Map<string, string[]>();

  for (const id of nodeIds) {
    inDegree.set(id, 0);
    adj.set(id, []);
  }

  for (const edge of forwardEdges) {
    if (!nodeIds.has(edge.from) || !nodeIds.has(edge.to)) continue;
    adj.get(edge.from)!.push(edge.to);
    inDegree.set(edge.to, (inDegree.get(edge.to) ?? 0) + 1);
  }

  // BFS by topological depth
  const depthMap = new Map<string, number>();
  const queue: string[] = [];

  for (const [id, deg] of inDegree) {
    if (deg === 0) {
      queue.push(id);
      depthMap.set(id, 0);
    }
  }

  let head = 0;
  while (head < queue.length) {
    const current = queue[head++];
    const currentDepth = depthMap.get(current)!;

    for (const neighbor of adj.get(current) ?? []) {
      const newDeg = inDegree.get(neighbor)! - 1;
      inDegree.set(neighbor, newDeg);

      // Track maximum depth (longest path)
      const existingDepth = depthMap.get(neighbor);
      if (existingDepth === undefined || currentDepth + 1 > existingDepth) {
        depthMap.set(neighbor, currentDepth + 1);
      }

      if (newDeg === 0) {
        queue.push(neighbor);
      }
    }
  }

  // Nodes not reached (cycles without forward paths) get depth -1
  for (const id of nodeIds) {
    if (!depthMap.has(id)) depthMap.set(id, -1);
  }

  // Group by depth
  const layerMap = new Map<number, string[]>();
  for (const [id, depth] of depthMap) {
    if (!layerMap.has(depth)) layerMap.set(depth, []);
    layerMap.get(depth)!.push(id);
  }

  return Array.from(layerMap.entries())
    .sort(([a], [b]) => a - b)
    .map(([depth, nodes]) => ({ depth, nodes: nodes.sort() }));
}

// ---------------------------------------------------------------------------
// Pattern detection
// ---------------------------------------------------------------------------

function detectPatterns(ast: TopologyAST): DetectedPattern[] {
  const patterns: DetectedPattern[] = [];
  const edges = ast.edges;
  const degrees = computeDegrees(edges);
  const adj = buildAdjacency(edges);

  // Pipeline: find longest chain of nodes with in-degree=1, out-degree=1
  const chainNodes = new Set<string>();
  for (const [id, deg] of degrees) {
    if (deg.in <= 1 && deg.out <= 1) chainNodes.add(id);
  }

  // Trace chains from source nodes (in-degree 0)
  const chains: string[][] = [];
  const visited = new Set<string>();

  for (const [id, deg] of degrees) {
    if (deg.in === 0 && !visited.has(id)) {
      const chain: string[] = [id];
      visited.add(id);
      let current = id;

      while (true) {
        const neighbors = adj.get(current);
        // Follow single outgoing forward edge
        const forwardNeighbors = neighbors?.filter((n) => {
          const edge = edges.find((e) => e.from === current && e.to === n);
          return edge && !edge.maxIterations;
        });

        if (!forwardNeighbors || forwardNeighbors.length !== 1) break;
        const next = forwardNeighbors[0];
        const nextDeg = degrees.get(next);
        // Stop if the next node has multiple incoming forward edges
        const incomingForward = edges.filter(
          (e) => e.to === next && !e.maxIterations,
        );
        if (incomingForward.length > 1) break;
        if (visited.has(next)) break;

        chain.push(next);
        visited.add(next);
        current = next;
      }

      if (chain.length >= 3) chains.push(chain);
    }
  }

  if (chains.length > 0) {
    const longest = chains.reduce((a, b) => (a.length >= b.length ? a : b));
    patterns.push({
      name: "pipeline",
      confidence: "definite",
      involvedNodes: longest,
      description: longest.join(" -> "),
    });
  }

  // Fan-out: node with multiple outgoing forward edges
  for (const [id, deg] of degrees) {
    if (deg.out > 1) {
      const targets = edges
        .filter((e) => e.from === id && !e.maxIterations)
        .map((e) => e.to);

      if (targets.length > 1) {
        patterns.push({
          name: "fan-out",
          confidence: "definite",
          involvedNodes: [id, ...targets],
          description: `${id} -> [${targets.join(", ")}]`,
        });
      }
    }
  }

  // Review-loop: back-edges with maxIterations
  const backEdges = edges.filter((e) => e.maxIterations);
  for (const edge of backEdges) {
    patterns.push({
      name: "review-loop",
      confidence: "definite",
      involvedNodes: [edge.from, edge.to],
      description: `${edge.from} -> ${edge.to} [max ${edge.maxIterations}]`,
    });
  }

  // Human-gate: any HumanNode in the graph
  const humanNodes = ast.nodes.filter((n): n is HumanNode => n.type === "human");
  for (const human of humanNodes) {
    patterns.push({
      name: "human-gate",
      confidence: "definite",
      involvedNodes: [human.id],
      description: `Human approval: ${human.id}`,
    });
  }

  // Group/debate: any GroupNode
  const groupNodes = ast.nodes.filter((n): n is GroupNode => n.type === "group");
  for (const group of groupNodes) {
    patterns.push({
      name: "group-chat",
      confidence: "definite",
      involvedNodes: [group.id, ...(group.members ?? [])],
      description: `Group: ${group.id} (${(group.members ?? []).join(", ")})`,
    });
  }

  // Memory infrastructure: detect if stores are present
  if (ast.stores && ast.stores.length > 0) {
    const storeIds = ast.stores.map((s) => s.id);
    patterns.push({
      name: "memory-infrastructure",
      confidence: "definite",
      involvedNodes: storeIds,
      description: `Memory stores: ${storeIds.join(", ")}`,
    });
  }

  return patterns;
}

// ---------------------------------------------------------------------------
// Suggestions
// ---------------------------------------------------------------------------

function generateSuggestions(ast: TopologyAST): Suggestion[] {
  const suggestions: Suggestion[] = [];

  for (const node of ast.nodes) {
    if (!isAgent(node)) continue;

    if (!node.prompt) {
      suggestions.push({
        level: "improvement",
        message: "Agent has no prompt",
        node: node.id,
      });
    }

    if (!node.retry) {
      suggestions.push({
        level: "info",
        message: "Agent has no retry configuration",
        node: node.id,
      });
    }

    if (!node.timeout) {
      suggestions.push({
        level: "info",
        message: "Agent has no timeout",
        node: node.id,
      });
    }
  }

  for (const node of ast.nodes) {
    if (!isGate(node)) continue;

    if (!node.checks || node.checks.length === 0) {
      suggestions.push({
        level: "improvement",
        message: "Gate has no checks defined",
        node: node.id,
      });
    }
  }

  // Memory-related suggestions
  const hasStores = ast.stores && ast.stores.length > 0;
  const hasRetrievals = ast.retrievals && ast.retrievals.length > 0;

  if (hasStores) {
    // Check if agents have memory stores assigned
    const agentsWithMemory = ast.nodes.filter(
      (n): n is AgentNode => isAgent(n) && (n.memory != null && n.memory.length > 0),
    );
    const agentsWithoutMemory = ast.nodes.filter(
      (n): n is AgentNode => isAgent(n) && (!n.memory || n.memory.length === 0),
    );

    if (agentsWithoutMemory.length > 0 && agentsWithMemory.length > 0) {
      for (const agent of agentsWithoutMemory) {
        suggestions.push({
          level: "info",
          message: "Agent has no memory stores assigned — consider assigning memory stores to this agent",
          node: agent.id,
        });
      }
    }

    // Check if stores exist but no retrieval strategy
    if (!hasRetrievals) {
      suggestions.push({
        level: "improvement",
        message: "Memory stores exist but no retrieval strategy is defined — consider adding a retrieval strategy",
      });
    }
  }

  // Declared vs detected pattern mismatch
  const detected = detectPatterns(ast);
  const detectedNames = new Set(detected.map((p) => p.name));
  const declared = new Set(ast.topology.patterns);

  for (const p of declared) {
    // Normalize: "human-gate" matches "human-gate"
    if (!detectedNames.has(p)) {
      suggestions.push({
        level: "info",
        message: `Declared pattern "${p}" was not detected in the flow graph`,
      });
    }
  }

  return suggestions;
}

// ---------------------------------------------------------------------------
// Main analysis function
// ---------------------------------------------------------------------------

export function analyze(ast: TopologyAST): AnalysisResult {
  const counts = {
    agents: 0,
    actions: 0,
    gates: 0,
    groups: 0,
    humans: 0,
    orchestrators: 0,
    stores: ast.stores ? ast.stores.length : 0,
  };

  for (const node of ast.nodes) {
    switch (node.type) {
      case "agent": counts.agents++; break;
      case "action": counts.actions++; break;
      case "gate": counts.gates++; break;
      case "group": counts.groups++; break;
      case "human": counts.humans++; break;
      case "orchestrator": counts.orchestrators++; break;
    }
  }

  const summary: TopologySummary = {
    name: ast.topology.name,
    version: ast.topology.version,
    description: ast.topology.description,
    nodeCount: counts,
    edgeCount: ast.edges.length,
    declaredPatterns: ast.topology.patterns,
  };

  const patterns = detectPatterns(ast);

  const nodeIds = new Set(ast.nodes.map((n) => n.id));
  const layers = computeLayers(ast.edges, nodeIds);

  const suggestions = generateSuggestions(ast);

  return { summary, patterns, layers, suggestions };
}

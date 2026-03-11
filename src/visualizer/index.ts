/**
 * AgentTopology Visualizer.
 *
 * Generates a self-contained HTML file that renders an interactive
 * topology graph from a parsed TopologyAST.  No external dependencies —
 * all CSS and JS are inlined.
 *
 * @module
 */

import type {
  TopologyAST,
  NodeDef,
  EdgeDef,
  AgentNode,
  GateNode,
  ActionNode,
  OrchestratorNode,
} from "../parser/ast.js";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Generate a self-contained HTML string that visualizes the given topology.
 *
 * Save the returned string to a `.html` file and open it in any browser.
 */
export function generateVisualization(ast: TopologyAST): string {
  const dataJson = JSON.stringify(astToViewData(ast));
  return buildHtml(dataJson, ast.topology.name);
}

// ---------------------------------------------------------------------------
// AST -> view data
// ---------------------------------------------------------------------------

interface ViewData {
  topology: {
    name: string;
    version: string;
    description: string;
    patterns: string[];
  };
  nodes: ViewNode[];
  edges: ViewEdge[];
}

interface ViewNode {
  id: string;
  type: string;
  label: string;
  model?: string;
  phase?: number;
  permissions?: string;
  tools?: string[];
  reads?: string[];
  writes?: string[];
  outputs?: Record<string, string[]>;
  checks?: string[];
  after?: string;
  before?: string;
  onFail?: string;
  role?: string;
  description?: string;
  invocation?: string;
  behavior?: string;
  skip?: string;
  isolation?: string;
  retry?: number;
  kind?: string;
}

interface ViewEdge {
  from: string;
  to: string;
  condition: string | null;
  maxIterations: number | null;
}

function astToViewData(ast: TopologyAST): ViewData {
  const nodes: ViewNode[] = ast.nodes.map((n) => {
    const base: ViewNode = { id: n.id, type: n.type, label: n.label };
    switch (n.type) {
      case "orchestrator": {
        const o = n as OrchestratorNode;
        if (o.model) base.model = o.model;
        if (o.outputs) base.outputs = o.outputs;
        break;
      }
      case "agent": {
        const a = n as AgentNode;
        if (a.model) base.model = a.model;
        if (a.phase != null) base.phase = a.phase;
        if (a.permissions) base.permissions = a.permissions;
        if (a.tools) base.tools = a.tools;
        if (a.reads) base.reads = a.reads;
        if (a.writes) base.writes = a.writes;
        if (a.outputs) base.outputs = a.outputs;
        if (a.role) base.role = a.role;
        if (a.invocation) base.invocation = a.invocation;
        if (a.behavior) base.behavior = a.behavior;
        if (a.skip) base.skip = a.skip;
        if (a.isolation) base.isolation = a.isolation;
        if (a.retry != null) base.retry = a.retry;
        break;
      }
      case "gate": {
        const g = n as GateNode;
        if (g.after) base.after = g.after;
        if (g.before) base.before = g.before;
        if (g.checks) base.checks = g.checks;
        if (g.onFail) base.onFail = g.onFail;
        if (g.behavior) base.behavior = g.behavior;
        if (g.retry != null) base.retry = g.retry;
        break;
      }
      case "action": {
        const act = n as ActionNode;
        if (act.kind) base.kind = act.kind;
        if (act.description) base.description = act.description;
        break;
      }
    }
    return base;
  });

  const edges: ViewEdge[] = ast.edges.map((e) => ({
    from: e.from,
    to: e.to,
    condition: e.condition,
    maxIterations: e.maxIterations,
  }));

  return {
    topology: {
      name: ast.topology.name,
      version: ast.topology.version,
      description: ast.topology.description,
      patterns: ast.topology.patterns,
    },
    nodes,
    edges,
  };
}

// ---------------------------------------------------------------------------
// HTML builder
// ---------------------------------------------------------------------------

function buildHtml(dataJson: string, title: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escHtml(title)} — AgentTopology Visualizer</title>
<style>
${CSS}
</style>
</head>
<body>
<div id="app">
  <header id="header">
    <div class="logo">Agent<span>Topology</span></div>
    <div class="topo-name" id="topo-name"></div>
    <div class="topo-ver" id="topo-ver"></div>
    <div class="topo-desc" id="topo-desc"></div>
    <div class="pattern-badges" id="pattern-badges"></div>
    <button class="header-btn" id="panel-btn" onclick="togglePanel()">Details &#9654;</button>
  </header>
  <div id="main">
    <div id="graph-container">
      <svg id="graph-svg"></svg>
      <div id="zoom-controls">
        <button class="zoom-btn" onclick="zoomIn()" title="Zoom In">+</button>
        <button class="zoom-btn" onclick="zoomOut()" title="Zoom Out">&minus;</button>
        <button class="zoom-btn" onclick="zoomFit()" title="Fit to View">&#8982;</button>
      </div>
      <div id="legend"></div>
    </div>
    <div id="side-panel" class="collapsed">
      <div id="panel-content">
        <div id="panel-empty">Click a node to inspect</div>
      </div>
    </div>
  </div>
</div>
<script>
const DATA = ${dataJson};
${JS}
</script>
</body>
</html>`;
}

function escHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ---------------------------------------------------------------------------
// Inline CSS
// ---------------------------------------------------------------------------

const CSS = `
*{margin:0;padding:0;box-sizing:border-box}
:root{
  --bg:#0a0a10;--s:#111120;--s2:#181830;--b:rgba(255,255,255,.08);--b2:rgba(255,255,255,.14);
  --t:#e4e4ef;--t2:#8888a8;--t3:#5858a0;
  --purple:#a78bfa;--purple-bg:rgba(167,139,250,.10);--purple-br:rgba(167,139,250,.25);
  --blue:#60a5fa;--blue-bg:rgba(96,165,250,.10);--blue-br:rgba(96,165,250,.25);
  --green:#4ade80;--green-bg:rgba(74,222,128,.10);--green-br:rgba(74,222,128,.25);
  --orange:#fb923c;--orange-bg:rgba(251,146,60,.10);--orange-br:rgba(251,146,60,.25);
  --gold:#fbbf24;--gold-bg:rgba(251,191,36,.10);--gold-br:rgba(251,191,36,.25);
  --gray:#94a3b8;--gray-bg:rgba(148,163,184,.08);--gray-br:rgba(148,163,184,.2);
  --red:#f87171;--red-bg:rgba(248,113,113,.10);--red-br:rgba(248,113,113,.25);
  --cyan:#22d3ee;
}
body{background:var(--bg);color:var(--t);font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;line-height:1.5;overflow:hidden;height:100vh}
#app{display:flex;flex-direction:column;height:100vh}
#header{padding:10px 20px;background:var(--s);border-bottom:1px solid var(--b);display:flex;align-items:center;gap:14px;flex-shrink:0;z-index:10}
#main{display:flex;flex:1;overflow:hidden}
#graph-container{flex:1;position:relative;overflow:hidden;cursor:grab}
#graph-container.dragging{cursor:grabbing}
#graph-svg{position:absolute;top:0;left:0}
#side-panel{width:340px;background:var(--s);border-left:1px solid var(--b);display:flex;flex-direction:column;flex-shrink:0;overflow:hidden;transition:width .2s}
#side-panel.collapsed{width:0;border-left:none}
#panel-content{flex:1;overflow-y:auto;padding:16px}
#panel-empty{color:var(--t2);font-size:13px;text-align:center;margin-top:40px}

.logo{font-weight:700;font-size:15px;color:var(--t);letter-spacing:-.5px}
.logo span{color:var(--purple)}
.topo-name{font-family:monospace;font-size:12px;color:var(--t2);background:var(--s2);padding:3px 10px;border-radius:6px;border:1px solid var(--b)}
.topo-ver{font-family:monospace;font-size:11px;color:var(--t3)}
.topo-desc{font-size:12px;color:var(--t2);flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pattern-badges{display:flex;gap:5px;flex-wrap:wrap}
.pattern-badge{font-family:monospace;font-size:9px;padding:2px 7px;border-radius:4px;text-transform:uppercase;letter-spacing:.5px;font-weight:500;background:var(--blue-bg);color:var(--blue);border:1px solid var(--blue-br)}
.header-btn{background:var(--s2);border:1px solid var(--b);color:var(--t2);padding:5px 12px;border-radius:6px;font-size:11px;cursor:pointer;transition:all .15s;font-family:monospace;letter-spacing:.3px}
.header-btn:hover{background:rgba(255,255,255,.06);color:var(--t);border-color:var(--b2)}

.node-group{cursor:pointer}
.node-group.dimmed{opacity:.18}
.node-label{fill:var(--t);font-size:12px;font-weight:600;text-anchor:middle;dominant-baseline:central;pointer-events:none;letter-spacing:-.2px}
.node-sublabel{fill:var(--t2);font-size:9px;text-anchor:middle;dominant-baseline:central;pointer-events:none;font-family:monospace}
.edge-path{fill:none;stroke-width:1.5}
.edge-path.unconditional{stroke:rgba(255,255,255,.18)}
.edge-path.conditional{stroke:var(--t3);stroke-dasharray:6 4}
.edge-path.loop{stroke:var(--orange);stroke-dasharray:4 4}
.edge-group.dimmed .edge-path{opacity:.06}
.edge-group.highlighted .edge-path{stroke-width:2.5;opacity:1}
.edge-label{font-family:monospace;font-size:8px;fill:var(--t3)}

@keyframes marchAnts{from{stroke-dashoffset:0}to{stroke-dashoffset:-20}}
.edge-path.conditional,.edge-path.loop{animation:marchAnts 4s linear infinite}
.node-group .node-shape{transition:filter .2s}
.node-selected .node-shape{stroke-width:2.5!important;filter:brightness(1.3)!important}

#zoom-controls{position:absolute;bottom:16px;right:16px;display:flex;flex-direction:column;gap:4px;z-index:5}
.zoom-btn{width:32px;height:32px;background:var(--s);border:1px solid var(--b);border-radius:6px;color:var(--t2);font-size:16px;cursor:pointer;display:flex;align-items:center;justify-content:center;transition:all .15s;font-family:monospace}
.zoom-btn:hover{background:rgba(255,255,255,.06);color:var(--t);border-color:var(--b2)}

#legend{position:absolute;bottom:16px;left:16px;background:var(--s);border:1px solid var(--b);border-radius:8px;padding:12px 16px;z-index:5;font-size:10px}
.legend-row{display:flex;align-items:center;gap:8px;margin:3px 0}
.legend-swatch{width:12px;height:12px;border-radius:3px;flex-shrink:0}
.legend-line{width:20px;height:0;border-top:2px solid;flex-shrink:0}
.legend-line.dashed{border-top-style:dashed}
.legend-label{color:var(--t2);font-size:10px}

.detail-section{margin-bottom:16px}
.detail-title{font-family:monospace;font-size:10px;color:var(--t3);text-transform:uppercase;letter-spacing:1px;margin-bottom:6px;font-weight:600}
.detail-row{display:flex;gap:8px;margin-bottom:4px;font-size:12px}
.detail-key{color:var(--t3);min-width:80px;font-family:monospace;flex-shrink:0;font-weight:500}
.detail-val{color:var(--t)}
.detail-chip{display:inline-block;font-family:monospace;font-size:10px;padding:2px 7px;border-radius:4px;margin:2px;background:var(--s2);color:var(--t2);border:1px solid var(--b)}
.detail-header{display:flex;align-items:center;gap:12px;margin-bottom:16px;padding-bottom:12px;border-bottom:1px solid var(--b)}
.detail-icon{width:40px;height:40px;border-radius:10px;display:flex;align-items:center;justify-content:center;font-size:18px;flex-shrink:0}
.detail-name{font-size:16px;font-weight:600}
.detail-type{font-family:monospace;font-size:10px;text-transform:uppercase;letter-spacing:1px;padding:2px 8px;border-radius:4px;font-weight:500}

::-webkit-scrollbar{width:5px}
::-webkit-scrollbar-track{background:transparent}
::-webkit-scrollbar-thumb{background:rgba(255,255,255,.08);border-radius:3px}
`;

// ---------------------------------------------------------------------------
// Inline JS
// ---------------------------------------------------------------------------

const JS = `
// === State ===
let selectedNode = null;
let transform = { x: 0, y: 0, scale: 1 };
let isPanning = false, panStart = { x: 0, y: 0 };
let nodePositions = {};

// === Constants ===
const NODE_W = 160, NODE_H = 56;
const ORCH_W = 200, ORCH_H = 60;
const GATE_W = 120, GATE_H = 44;
const ACTION_W = 140, ACTION_H = 54;
const COL_GAP = 70, ROW_GAP = 90;

// === Color helpers ===
function typeColor(type) {
  switch (type) {
    case 'agent': return { main: '#a78bfa', bg: 'rgba(167,139,250,.10)', br: 'rgba(167,139,250,.25)' };
    case 'action': return { main: '#94a3b8', bg: 'rgba(148,163,184,.08)', br: 'rgba(148,163,184,.2)' };
    case 'gate': return { main: '#fb923c', bg: 'rgba(251,146,60,.10)', br: 'rgba(251,146,60,.25)' };
    case 'orchestrator': return { main: '#fbbf24', bg: 'rgba(251,191,36,.10)', br: 'rgba(251,191,36,.25)' };
    default: return { main: '#94a3b8', bg: 'rgba(148,163,184,.08)', br: 'rgba(148,163,184,.2)' };
  }
}
function typeIcon(type) {
  switch (type) {
    case 'agent': return '\\u2726';
    case 'action': return '\\u25C7';
    case 'gate': return '\\u2B21';
    case 'orchestrator': return '\\u2B22';
    default: return '\\u25CB';
  }
}
function nodeSize(node) {
  if (node.type === 'orchestrator') return { w: ORCH_W, h: ORCH_H };
  if (node.type === 'gate') return { w: GATE_W, h: GATE_H };
  if (node.type === 'action') return { w: ACTION_W, h: ACTION_H };
  return { w: NODE_W, h: NODE_H };
}

// === Layout engine ===
function layoutNodes(nodes, edges) {
  const positions = {};
  const nodeMap = {};
  nodes.forEach(n => nodeMap[n.id] = n);

  const orchestratorNode = nodes.find(n => n.type === 'orchestrator');
  const gateNodes = nodes.filter(n => n.type === 'gate');
  const gateIds = new Set(gateNodes.map(g => g.id));
  const manualNodes = nodes.filter(n => n.invocation === 'manual');
  const manualIds = new Set(manualNodes.map(n => n.id));

  // Build forward edge set (no loops)
  const forwardEdges = edges.filter(e => !e.maxIterations);
  const flowNodeIds = new Set();
  forwardEdges.forEach(e => { flowNodeIds.add(e.from); flowNodeIds.add(e.to); });
  gateIds.forEach(id => flowNodeIds.delete(id));
  manualIds.forEach(id => flowNodeIds.delete(id));

  // Detect connected subgraphs
  const undirAdj = {};
  flowNodeIds.forEach(id => { undirAdj[id] = new Set(); });
  forwardEdges.forEach(e => {
    if (flowNodeIds.has(e.from) && flowNodeIds.has(e.to)) {
      undirAdj[e.from].add(e.to);
      undirAdj[e.to].add(e.from);
    }
  });
  edges.filter(e => e.maxIterations).forEach(e => {
    if (flowNodeIds.has(e.from) && flowNodeIds.has(e.to)) {
      undirAdj[e.from].add(e.to);
      undirAdj[e.to].add(e.from);
    }
  });

  const visited = new Set();
  const subgraphs = [];
  flowNodeIds.forEach(id => {
    if (visited.has(id)) return;
    const component = [];
    const q = [id];
    while (q.length > 0) {
      const cur = q.shift();
      if (visited.has(cur)) continue;
      visited.add(cur);
      component.push(cur);
      (undirAdj[cur] || new Set()).forEach(nb => { if (!visited.has(nb)) q.push(nb); });
    }
    subgraphs.push(component);
  });
  subgraphs.sort((a, b) => b.length - a.length || a[0].localeCompare(b[0]));

  // Topological rank within a subgraph
  function rankSubgraph(sgNodeIds) {
    const sgSet = new Set(sgNodeIds);
    const adj = {}, inDeg = {};
    sgSet.forEach(id => { adj[id] = []; inDeg[id] = 0; });
    forwardEdges.forEach(e => {
      if (sgSet.has(e.from) && sgSet.has(e.to)) {
        adj[e.from].push(e.to);
        inDeg[e.to] = (inDeg[e.to] || 0) + 1;
      }
    });
    const rank = {};
    const queue = [];
    sgSet.forEach(id => { if (!inDeg[id]) { queue.push(id); rank[id] = 0; } });
    const processed = new Set();
    while (queue.length > 0) {
      const curr = queue.shift();
      if (processed.has(curr)) continue;
      const allReady = forwardEdges
        .filter(e => e.to === curr && sgSet.has(e.from))
        .every(e => processed.has(e.from));
      if (!allReady && processed.size > 0) { queue.push(curr); continue; }
      processed.add(curr);
      (adj[curr] || []).forEach(next => {
        rank[next] = Math.max(rank[next] || 0, rank[curr] + 1);
        if (!queue.includes(next)) queue.push(next);
      });
    }
    sgSet.forEach(id => { if (rank[id] === undefined) rank[id] = 0; });
    return rank;
  }

  let globalStartY = 40;
  if (orchestratorNode) {
    const sz = nodeSize(orchestratorNode);
    positions[orchestratorNode.id] = { x: 500, y: globalStartY, w: sz.w, h: sz.h };
    globalStartY += sz.h + ROW_GAP;
  }

  let columnX = 500;
  const subgraphCenters = [];
  const SUBGRAPH_GAP = 160;

  subgraphs.forEach((sgNodeIds, sgIdx) => {
    const rank = rankSubgraph(sgNodeIds);
    const rankGroups = {};
    sgNodeIds.forEach(id => {
      const r = rank[id];
      if (!rankGroups[r]) rankGroups[r] = [];
      rankGroups[r].push(id);
    });
    Object.keys(rankGroups).forEach(r => {
      rankGroups[r].sort((a, b) => {
        const pa = nodeMap[a]?.phase ?? 99, pb = nodeMap[b]?.phase ?? 99;
        return pa !== pb ? pa - pb : a.localeCompare(b);
      });
    });

    const sortedRanks = Object.keys(rankGroups).map(Number).sort((a, b) => a - b);
    let maxRowWidth = 0;
    sortedRanks.forEach(r => {
      const group = rankGroups[r];
      const sizes = group.map(id => nodeSize(nodeMap[id]));
      const totalW = sizes.reduce((s, sz) => s + sz.w, 0) + (group.length - 1) * COL_GAP;
      maxRowWidth = Math.max(maxRowWidth, totalW);
    });

    if (sgIdx > 0) columnX += maxRowWidth / 2 + SUBGRAPH_GAP;
    const centerX = columnX;
    subgraphCenters.push(centerX);

    let curY = globalStartY;
    sortedRanks.forEach(r => {
      const group = rankGroups[r];
      const sizes = group.map(id => nodeSize(nodeMap[id]));
      const totalW = sizes.reduce((s, sz) => s + sz.w, 0) + (group.length - 1) * COL_GAP;
      const maxH = Math.max(...sizes.map(s => s.h));
      let x = centerX - totalW / 2;
      group.forEach((id, i) => {
        const sz = sizes[i];
        positions[id] = { x: x + sz.w / 2, y: curY + (maxH - sz.h) / 2, w: sz.w, h: sz.h };
        x += sz.w + COL_GAP;
      });
      curY += maxH + ROW_GAP;
    });

    if (sgIdx === 0) columnX += maxRowWidth / 2;
  });

  // Re-center orchestrator
  if (orchestratorNode && subgraphCenters.length > 0) {
    positions[orchestratorNode.id].x = subgraphCenters[0];
  }

  // Position gates between their after/before nodes
  gateNodes.forEach(gate => {
    if (gate.after && gate.before && positions[gate.after] && positions[gate.before]) {
      const ap = positions[gate.after], bp = positions[gate.before];
      const sz = nodeSize(gate);
      positions[gate.id] = {
        x: (ap.x + bp.x) / 2,
        y: ap.y + ap.h + (bp.y - ap.y - ap.h) / 2 - sz.h / 2,
        w: sz.w, h: sz.h
      };
    } else if (gate.after && positions[gate.after]) {
      const ap = positions[gate.after];
      const sz = nodeSize(gate);
      positions[gate.id] = {
        x: ap.x + ap.w / 2 + sz.w / 2 + 30,
        y: ap.y + ap.h / 2 - sz.h / 2,
        w: sz.w, h: sz.h
      };
    }
  });

  // Manual nodes in a sidebar
  if (manualNodes.length > 0) {
    let maxRightX = 500;
    Object.values(positions).forEach(p => { maxRightX = Math.max(maxRightX, p.x + p.w / 2); });
    const sideX = maxRightX + 120;
    let sideY = 80;
    manualNodes.forEach(n => {
      const sz = nodeSize(n);
      positions[n.id] = { x: sideX, y: sideY, w: sz.w, h: sz.h };
      sideY += sz.h + 24;
    });
  }

  // Disconnected nodes
  const placed = new Set(Object.keys(positions));
  const disconnected = nodes.filter(n => n.type !== 'orchestrator' && !placed.has(n.id));
  if (disconnected.length > 0) {
    let maxRightX = 0;
    Object.values(positions).forEach(p => { maxRightX = Math.max(maxRightX, p.x + p.w / 2); });
    const sideX = maxRightX + 140;
    let y = 80;
    disconnected.forEach(n => {
      const sz = nodeSize(n);
      positions[n.id] = { x: sideX, y, w: sz.w, h: sz.h };
      y += sz.h + 24;
    });
  }

  return positions;
}

// === SVG rendering ===
function createSvgEl(tag, attrs) {
  const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [k, v] of Object.entries(attrs || {})) el.setAttribute(k, v);
  return el;
}

function edgePath(fromPos, toPos) {
  const x1 = fromPos.x, y1 = fromPos.y + fromPos.h / 2;
  const x2 = toPos.x, y2 = toPos.y - toPos.h / 2;
  const dy = y2 - y1;

  // If target is above or same level, route around
  if (dy < 30) {
    const offsetX = Math.max(Math.abs(x2 - x1) * 0.3, 60);
    const side = x2 >= x1 ? 1 : -1;
    return 'M' + x1 + ',' + y1 +
      ' C' + (x1 + side * offsetX) + ',' + (y1 + 60) +
      ' ' + (x2 - side * offsetX) + ',' + (y2 - 60) +
      ' ' + x2 + ',' + y2;
  }

  const cp = dy * 0.4;
  return 'M' + x1 + ',' + y1 +
    ' C' + x1 + ',' + (y1 + cp) +
    ' ' + x2 + ',' + (y2 - cp) +
    ' ' + x2 + ',' + y2;
}

function renderGraph() {
  const svg = document.getElementById('graph-svg');
  svg.innerHTML = '';

  const nodes = DATA.nodes;
  const edges = DATA.edges;
  nodePositions = layoutNodes(nodes, edges);
  const nodeMap = {};
  nodes.forEach(n => nodeMap[n.id] = n);

  // Defs for arrow markers
  const defs = createSvgEl('defs');
  ['#666', '#fb923c', '#5858a0'].forEach((color, i) => {
    const marker = createSvgEl('marker', {
      id: 'arrow-' + i, viewBox: '0 0 10 10', refX: '9', refY: '5',
      markerWidth: '6', markerHeight: '6', orient: 'auto-start-reverse'
    });
    const path = createSvgEl('path', { d: 'M0,0 L10,5 L0,10 Z', fill: color });
    marker.appendChild(path);
    defs.appendChild(marker);
  });
  svg.appendChild(defs);

  // Main group for pan/zoom
  const g = createSvgEl('g', { id: 'main-group' });
  svg.appendChild(g);

  // Draw edges
  edges.forEach(e => {
    const fromPos = nodePositions[e.from];
    const toPos = nodePositions[e.to];
    if (!fromPos || !toPos) return;

    const eg = createSvgEl('g', { class: 'edge-group', 'data-from': e.from, 'data-to': e.to });
    const isLoop = e.maxIterations != null;
    const isCond = e.condition != null;
    const cls = isLoop ? 'loop' : (isCond ? 'conditional' : 'unconditional');
    const markerIdx = isLoop ? 1 : (isCond ? 2 : 0);

    const path = createSvgEl('path', {
      class: 'edge-path ' + cls,
      d: edgePath(fromPos, toPos),
      'marker-end': 'url(#arrow-' + markerIdx + ')'
    });
    eg.appendChild(path);

    // Edge label
    if (e.condition || e.maxIterations) {
      const mx = (fromPos.x + toPos.x) / 2;
      const my = (fromPos.y + fromPos.h / 2 + toPos.y - toPos.h / 2) / 2;
      let labelText = '';
      if (e.condition) {
        const short = e.condition.replace(/[a-z-]+\\./g, '').replace(/ == /g, '=');
        labelText = short;
      }
      if (e.maxIterations) labelText += (labelText ? ' ' : '') + 'max ' + e.maxIterations;

      const label = createSvgEl('text', {
        class: 'edge-label', x: mx + 8, y: my, 'font-size': '8', fill: '#5858a0'
      });
      label.textContent = labelText;
      eg.appendChild(label);
    }

    g.appendChild(eg);
  });

  // Draw nodes
  nodes.forEach(node => {
    const pos = nodePositions[node.id];
    if (!pos) return;
    const tc = typeColor(node.type);
    const ng = createSvgEl('g', {
      class: 'node-group', 'data-id': node.id,
      transform: 'translate(' + (pos.x - pos.w / 2) + ',' + (pos.y - pos.h / 2) + ')'
    });
    ng.addEventListener('click', () => selectNode(node.id));

    // Background rect
    const rect = createSvgEl('rect', {
      class: 'node-shape', width: pos.w, height: pos.h, rx: node.type === 'gate' ? '6' : '10',
      fill: tc.bg, stroke: tc.br, 'stroke-width': '1'
    });
    ng.appendChild(rect);

    // Icon + label
    const icon = createSvgEl('text', {
      x: '14', y: pos.h / 2, fill: tc.main, 'font-size': '14',
      'dominant-baseline': 'central', 'pointer-events': 'none'
    });
    icon.textContent = typeIcon(node.type);
    ng.appendChild(icon);

    const label = createSvgEl('text', {
      class: 'node-label', x: pos.w / 2 + 8, y: pos.h * 0.38
    });
    label.textContent = node.label;
    ng.appendChild(label);

    // Sublabel
    let sub = node.type;
    if (node.model) sub += ' / ' + node.model;
    if (node.phase != null) sub = 'phase ' + node.phase + ' / ' + (node.model || node.type);
    const sublabel = createSvgEl('text', {
      class: 'node-sublabel', x: pos.w / 2 + 8, y: pos.h * 0.68
    });
    sublabel.textContent = sub;
    ng.appendChild(sublabel);

    g.appendChild(ng);
  });

  // Calculate bounds and size SVG
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  Object.values(nodePositions).forEach(p => {
    minX = Math.min(minX, p.x - p.w / 2);
    minY = Math.min(minY, p.y - p.h / 2);
    maxX = Math.max(maxX, p.x + p.w / 2);
    maxY = Math.max(maxY, p.y + p.h / 2);
  });
  const pad = 80;
  svg.setAttribute('width', maxX - minX + pad * 2);
  svg.setAttribute('height', maxY - minY + pad * 2);
  svg.setAttribute('viewBox', (minX - pad) + ' ' + (minY - pad) + ' ' + (maxX - minX + pad * 2) + ' ' + (maxY - minY + pad * 2));

  applyTransform();
  zoomFit();
}

function applyTransform() {
  const g = document.getElementById('main-group');
  if (g) g.setAttribute('transform', 'translate(' + transform.x + ',' + transform.y + ') scale(' + transform.scale + ')');
}

// === Pan & Zoom ===
const gc = document.getElementById('graph-container');
gc.addEventListener('mousedown', e => {
  if (e.target.closest('.node-group') || e.target.closest('.zoom-btn')) return;
  isPanning = true;
  panStart = { x: e.clientX - transform.x, y: e.clientY - transform.y };
  gc.classList.add('dragging');
});
gc.addEventListener('mousemove', e => {
  if (!isPanning) return;
  transform.x = e.clientX - panStart.x;
  transform.y = e.clientY - panStart.y;
  applyTransform();
});
gc.addEventListener('mouseup', () => { isPanning = false; gc.classList.remove('dragging'); });
gc.addEventListener('mouseleave', () => { isPanning = false; gc.classList.remove('dragging'); });
gc.addEventListener('wheel', e => {
  e.preventDefault();
  const delta = e.deltaY > 0 ? 0.9 : 1.1;
  const rect = gc.getBoundingClientRect();
  const mx = e.clientX - rect.left, my = e.clientY - rect.top;
  transform.x = mx - (mx - transform.x) * delta;
  transform.y = my - (my - transform.y) * delta;
  transform.scale *= delta;
  applyTransform();
}, { passive: false });

function zoomIn() { transform.scale *= 1.2; applyTransform(); }
function zoomOut() { transform.scale *= 0.8; applyTransform(); }
function zoomFit() {
  const svg = document.getElementById('graph-svg');
  const rect = gc.getBoundingClientRect();
  const vb = svg.getAttribute('viewBox').split(' ').map(Number);
  const scaleX = rect.width / vb[2];
  const scaleY = rect.height / vb[3];
  transform.scale = Math.min(scaleX, scaleY) * 0.9;
  transform.x = (rect.width - vb[2] * transform.scale) / 2 - vb[0] * transform.scale;
  transform.y = (rect.height - vb[3] * transform.scale) / 2 - vb[1] * transform.scale;
  applyTransform();
}

// === Node selection ===
function selectNode(id) {
  selectedNode = id;
  const node = DATA.nodes.find(n => n.id === id);

  // Highlight
  document.querySelectorAll('.node-group').forEach(ng => {
    ng.classList.remove('node-selected', 'dimmed', 'highlighted');
  });
  document.querySelectorAll('.edge-group').forEach(eg => {
    eg.classList.remove('dimmed', 'highlighted');
  });
  if (node) {
    document.querySelector('.node-group[data-id="' + id + '"]')?.classList.add('node-selected');
    const connected = new Set([id]);
    DATA.edges.forEach(e => {
      if (e.from === id) connected.add(e.to);
      if (e.to === id) connected.add(e.from);
    });
    document.querySelectorAll('.node-group').forEach(ng => {
      const nid = ng.getAttribute('data-id');
      ng.classList.add(connected.has(nid) ? 'highlighted' : 'dimmed');
    });
    document.querySelectorAll('.edge-group').forEach(eg => {
      const from = eg.getAttribute('data-from');
      const to = eg.getAttribute('data-to');
      eg.classList.add((from === id || to === id) ? 'highlighted' : 'dimmed');
    });
  }

  // Panel
  const panel = document.getElementById('side-panel');
  panel.classList.remove('collapsed');
  const content = document.getElementById('panel-content');
  if (!node) { content.innerHTML = '<div id="panel-empty">Click a node to inspect</div>'; return; }

  const tc = typeColor(node.type);
  let html = '<div class="detail-header">';
  html += '<div class="detail-icon" style="background:' + tc.bg + ';border:1px solid ' + tc.br + '">' + typeIcon(node.type) + '</div>';
  html += '<div><div class="detail-name">' + esc(node.label) + '</div>';
  html += '<span class="detail-type" style="background:' + tc.bg + ';color:' + tc.main + ';border:1px solid ' + tc.br + '">' + node.type + '</span></div></div>';

  if (node.role) html += '<div style="font-size:12px;color:var(--t2);margin-bottom:16px;line-height:1.6">' + esc(node.role) + '</div>';
  if (node.description) html += '<div style="font-size:12px;color:var(--t2);margin-bottom:16px;line-height:1.6">' + esc(node.description) + '</div>';

  html += '<div class="detail-section">';
  html += '<div class="detail-title">Properties</div>';
  if (node.model) html += detailRow('Model', node.model);
  if (node.phase != null) html += detailRow('Phase', node.phase);
  if (node.permissions) html += detailRow('Permissions', node.permissions);
  if (node.kind) html += detailRow('Kind', node.kind);
  if (node.invocation) html += detailRow('Invocation', node.invocation);
  if (node.behavior) html += detailRow('Behavior', node.behavior);
  if (node.isolation) html += detailRow('Isolation', node.isolation);
  if (node.retry != null) html += detailRow('Retry', node.retry);
  if (node.skip) html += detailRow('Skip', node.skip);
  if (node.after) html += detailRow('After', node.after);
  if (node.before) html += detailRow('Before', node.before);
  if (node.onFail) html += detailRow('On Fail', node.onFail);
  html += '</div>';

  if (node.tools && node.tools.length > 0) {
    html += '<div class="detail-section"><div class="detail-title">Tools</div>';
    node.tools.forEach(t => { html += '<span class="detail-chip">' + esc(t) + '</span>'; });
    html += '</div>';
  }
  if (node.reads && node.reads.length > 0) {
    html += '<div class="detail-section"><div class="detail-title">Reads</div>';
    node.reads.forEach(r => { html += '<span class="detail-chip">' + esc(r) + '</span>'; });
    html += '</div>';
  }
  if (node.writes && node.writes.length > 0) {
    html += '<div class="detail-section"><div class="detail-title">Writes</div>';
    node.writes.forEach(w => { html += '<span class="detail-chip">' + esc(w) + '</span>'; });
    html += '</div>';
  }
  if (node.checks && node.checks.length > 0) {
    html += '<div class="detail-section"><div class="detail-title">Checks</div>';
    node.checks.forEach(c => { html += '<span class="detail-chip">' + esc(c) + '</span>'; });
    html += '</div>';
  }
  if (node.outputs) {
    html += '<div class="detail-section"><div class="detail-title">Outputs</div>';
    Object.entries(node.outputs).forEach(([k, vals]) => {
      html += '<div style="margin-bottom:4px"><span style="color:var(--t3);font-family:monospace;font-size:11px">' + esc(k) + ':</span> ';
      vals.forEach(v => { html += '<span class="detail-chip">' + esc(v) + '</span>'; });
      html += '</div>';
    });
    html += '</div>';
  }

  // Connected edges
  const inEdges = DATA.edges.filter(e => e.to === id);
  const outEdges = DATA.edges.filter(e => e.from === id);
  if (inEdges.length > 0 || outEdges.length > 0) {
    html += '<div class="detail-section"><div class="detail-title">Connections</div>';
    inEdges.forEach(e => {
      let desc = esc(e.from) + ' \\u2192 here';
      if (e.condition) desc += ' [' + esc(e.condition) + ']';
      if (e.maxIterations) desc += ' (max ' + e.maxIterations + ')';
      html += '<div style="font-size:11px;color:var(--t2);margin-bottom:2px;font-family:monospace">' + desc + '</div>';
    });
    outEdges.forEach(e => {
      let desc = 'here \\u2192 ' + esc(e.to);
      if (e.condition) desc += ' [' + esc(e.condition) + ']';
      if (e.maxIterations) desc += ' (max ' + e.maxIterations + ')';
      html += '<div style="font-size:11px;color:var(--t2);margin-bottom:2px;font-family:monospace">' + desc + '</div>';
    });
    html += '</div>';
  }

  content.innerHTML = html;
}

function detailRow(key, val) {
  return '<div class="detail-row"><span class="detail-key">' + esc(key) + '</span><span class="detail-val">' + esc(String(val)) + '</span></div>';
}
function esc(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

// === Panel toggle ===
function togglePanel() {
  document.getElementById('side-panel').classList.toggle('collapsed');
}

// === Initialize ===
function init() {
  document.getElementById('topo-name').textContent = DATA.topology.name;
  document.getElementById('topo-ver').textContent = 'v' + DATA.topology.version;
  document.getElementById('topo-desc').textContent = DATA.topology.description;

  const badges = document.getElementById('pattern-badges');
  DATA.topology.patterns.forEach(p => {
    const span = document.createElement('span');
    span.className = 'pattern-badge';
    span.textContent = p;
    badges.appendChild(span);
  });

  // Legend
  const legend = document.getElementById('legend');
  legend.innerHTML =
    '<div style="font-family:monospace;font-size:8px;color:var(--t3);text-transform:uppercase;letter-spacing:1px;margin-bottom:6px;font-weight:600">Legend</div>' +
    legendRow('#a78bfa', 'Agent') +
    legendRow('#94a3b8', 'Action') +
    legendRow('#fb923c', 'Gate') +
    legendRow('#fbbf24', 'Orchestrator') +
    '<div style="margin-top:6px">' +
    legendLine('rgba(255,255,255,.18)', false, 'Direct flow') +
    legendLine('#5858a0', true, 'Conditional') +
    legendLine('#fb923c', true, 'Loop') +
    '</div>';

  renderGraph();
}

function legendRow(color, label) {
  return '<div class="legend-row"><div class="legend-swatch" style="background:' + color + '20;border:1px solid ' + color + '40"></div><span class="legend-label">' + label + '</span></div>';
}
function legendLine(color, dashed, label) {
  return '<div class="legend-row"><div class="legend-line' + (dashed ? ' dashed' : '') + '" style="border-color:' + color + '"></div><span class="legend-label">' + label + '</span></div>';
}

init();
`;

// ---------------------------------------------------------------------------

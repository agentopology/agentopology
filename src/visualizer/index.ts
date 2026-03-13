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
// AST -> view data  (matches the DEFAULT_DATA shape in the advanced viewer)
// ---------------------------------------------------------------------------

/* eslint-disable @typescript-eslint/no-explicit-any */
function astToViewData(ast: TopologyAST): Record<string, any> {
  const nodes: Record<string, any>[] = ast.nodes.map((n: NodeDef) => {
    const base: Record<string, any> = { id: n.id, type: n.type, label: n.label };
    switch (n.type) {
      case "orchestrator": {
        const o = n as OrchestratorNode;
        if (o.model) base.model = o.model;
        if (o.generates) base.generates = o.generates;
        if (o.handles && o.handles.length > 0) base.handles = o.handles;
        if (o.outputs) base.outputs = o.outputs;
        break;
      }
      case "agent": {
        const a = n as AgentNode;
        if (a.model) base.model = a.model;
        if (a.phase != null) base.phase = a.phase;
        if (a.permissions) base.permissions = a.permissions;
        if (a.tools) base.tools = a.tools;
        if (a.skills) base.skills = a.skills;
        if (a.reads) base.reads = a.reads;
        if (a.writes) base.writes = a.writes;
        if (a.outputs) base.outputs = a.outputs;
        if (a.role) base.role = a.role;
        if (a.description) base.description = a.description;
        if (a.invocation) base.invocation = a.invocation;
        if (a.behavior) base.behavior = a.behavior;
        if (a.skip) base.skip = a.skip;
        if (a.isolation) base.isolation = a.isolation;
        if (a.retry != null) base.retry = a.retry;
        if (a.background) base.background = a.background;
        if (a.mcpServers) base.mcpServers = a.mcpServers;
        if (a.scale) base.scale = a.scale;
        if (a.hooks && a.hooks.length > 0) base.hooks = a.hooks;
        if (a.disallowedTools) base.disallowedTools = a.disallowedTools;
        if (a.prompt) base.prompt = a.prompt;
        if (a.maxTurns != null) base.maxTurns = a.maxTurns;
        if (a.sandbox != null) base.sandbox = a.sandbox;
        if (a.fallbackChain) base.fallbackChain = a.fallbackChain;
        break;
      }
      case "gate": {
        const g = n as GateNode;
        if (g.after) base.after = g.after;
        if (g.before) base.before = g.before;
        if (g.run) base.run = g.run;
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
        if (act.source) base.source = act.source;
        if (act.commands) base.commands = act.commands;
        break;
      }
    }
    return base;
  });

  const edges = ast.edges.map((e) => ({
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
      foundations: ast.topology.foundations || [],
      advanced: ast.topology.advanced || [],
    },
    nodes,
    edges,
    depth: ast.depth,
    memory: ast.memory,
    batch: ast.batch,
    environments: ast.environments,
    triggers: ast.triggers,
    hooks: ast.hooks,
    settings: ast.settings,
    mcpServers: ast.mcpServers,
    metering: ast.metering,
    skills: ast.skills,
    toolDefs: ast.toolDefs,
    runs: [],
  };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

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
  <div id="header">
    <div class="logo">Agent<span>Topology</span></div>
    <div class="topo-name" id="topo-name"></div>
    <div class="topo-ver" id="topo-ver"></div>
    <div class="topo-desc" id="topo-desc"></div>
    <div class="pattern-badges" id="pattern-badges"></div>
    <button class="header-btn" id="dataflow-btn" onclick="toggleDataFlow()">Data Flow</button>
    <button class="header-btn" id="orientation-btn" onclick="toggleOrientation()" title="Switch between vertical and horizontal layout">&#8596; Horizontal</button>
    <button class="header-btn" onclick="openLoadModal()">Load JSON</button>
    <button class="header-btn" id="panel-btn" onclick="togglePanel()">Panel &#9654;</button>
  </div>
  <div id="main">
    <div id="graph-container">
      <svg id="graph-svg"></svg>
      <div id="zoom-controls">
        <button class="zoom-btn" onclick="zoomIn()" title="Zoom In">+</button>
        <button class="zoom-btn" onclick="zoomOut()" title="Zoom Out">&minus;</button>
        <button class="zoom-btn" onclick="zoomFit()" title="Fit">&#8982;</button>
      </div>
      <div id="legend"></div>
      <div class="svg-tooltip" id="tooltip"></div>
    </div>
    <div id="side-panel" class="collapsed">
      <div id="tab-bar">
        <div class="tab active" data-tab="inspect">Inspect</div>
        <div class="tab" data-tab="memory">Memory</div>
        <div class="tab" data-tab="runs">Runs</div>
        <div class="tab" data-tab="depth">Depth</div>
        <div class="tab" data-tab="batch">Batch</div>
        <div class="tab" data-tab="envs">Envs</div>
        <div class="tab" data-tab="triggers">Triggers</div>
        <div class="tab" data-tab="hooks">Hooks</div>
        <div class="tab" data-tab="mcp">MCP</div>
        <div class="tab" data-tab="skills">Skills</div>
        <div class="tab" data-tab="metering">Metering</div>
        <div class="tab" data-tab="settings">Settings</div>
      </div>
      <div id="tab-content">
        <div id="inspect-empty" style="color:var(--t2);font-size:13px;text-align:center;margin-top:40px">
          Click a node to inspect
        </div>
      </div>
    </div>
  </div>
</div>

<div id="load-modal">
  <div class="modal-content">
    <h3>Load Topology JSON</h3>
    <textarea class="modal-textarea" id="json-input" placeholder="Paste topology JSON here..."></textarea>
    <div class="modal-actions">
      <button class="modal-btn secondary" onclick="closeLoadModal()">Cancel</button>
      <button class="modal-btn primary" onclick="loadFromInput()">Load</button>
    </div>
  </div>
</div>

<script>
const DEFAULT_DATA = ${dataJson};
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
  --bg:#08080c;--s:#10101a;--s2:#16162a;--b:rgba(255,255,255,.08);--b2:rgba(255,255,255,.14);
  --t:#e4e4ef;--t2:#8888a8;--t3:#5858a0;
  --purple:#a78bfa;--purple-bg:rgba(167,139,250,.10);--purple-br:rgba(167,139,250,.25);
  --blue:#60a5fa;--blue-bg:rgba(96,165,250,.10);--blue-br:rgba(96,165,250,.25);
  --green:#4ade80;--green-bg:rgba(74,222,128,.10);--green-br:rgba(74,222,128,.25);
  --orange:#fb923c;--orange-bg:rgba(251,146,60,.10);--orange-br:rgba(251,146,60,.25);
  --gold:#fbbf24;--gold-bg:rgba(251,191,36,.10);--gold-br:rgba(251,191,36,.25);
  --gray:#94a3b8;--gray-bg:rgba(148,163,184,.08);--gray-br:rgba(148,163,184,.2);
  --red:#f87171;--red-bg:rgba(248,113,113,.10);--red-br:rgba(248,113,113,.25);
  --cyan:#22d3ee;--cyan-bg:rgba(34,211,238,.10);--cyan-br:rgba(34,211,238,.25);
  --amber:#f59e0b;--amber-bg:rgba(245,158,11,.10);--amber-br:rgba(245,158,11,.25);
  --pink:#f472b6;
  --font-mono:ui-monospace,'Courier New',monospace;
  --font-body:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
  --font-heading:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
}
body{background:var(--bg);color:var(--t);font-family:var(--font-body);line-height:1.5;overflow:hidden;height:100vh}
#app{display:flex;flex-direction:column;height:100vh}
#header{padding:10px 20px;background:var(--s);border-bottom:1px solid var(--b);display:flex;align-items:center;gap:14px;flex-shrink:0;z-index:10}
#main{display:flex;flex:1;overflow:hidden}
#graph-container{flex:1;position:relative;overflow:hidden;cursor:grab}
#graph-container.dragging{cursor:grabbing}
#graph-svg{position:absolute;top:0;left:0}
#side-panel{width:380px;background:var(--s);border-left:1px solid var(--b);display:flex;flex-direction:column;flex-shrink:0;overflow:hidden;transition:width .2s}
#side-panel.collapsed{width:0;border-left:none}

.logo{font-family:var(--font-heading);font-weight:700;font-size:15px;color:var(--t);letter-spacing:-.5px}
.logo span{color:var(--purple)}
.topo-name{font-family:var(--font-mono);font-size:12px;color:var(--t2);background:var(--s2);padding:3px 10px;border-radius:6px;border:1px solid var(--b)}
.topo-ver{font-family:var(--font-mono);font-size:11px;color:var(--t3)}
.topo-desc{font-family:var(--font-body);font-size:12px;color:var(--t2);flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pattern-badges{display:flex;gap:5px;flex-wrap:wrap}
.pattern-badge{font-family:var(--font-mono);font-size:9px;padding:2px 7px;border-radius:4px;text-transform:uppercase;letter-spacing:.5px;font-weight:500}
.pattern-badge.pipeline{background:var(--blue-bg);color:var(--blue);border:1px solid var(--blue-br)}
.pattern-badge.blackboard{background:var(--purple-bg);color:var(--purple);border:1px solid var(--purple-br)}
.pattern-badge.fan-out{background:var(--orange-bg);color:var(--orange);border:1px solid var(--orange-br)}
.pattern-badge.human-gate{background:var(--gold-bg);color:var(--gold);border:1px solid var(--gold-br)}
.header-btn{background:var(--s2);border:1px solid var(--b);color:var(--t2);padding:5px 12px;border-radius:6px;font-size:11px;cursor:pointer;transition:all .15s;font-family:var(--font-mono);letter-spacing:.3px}
.header-btn:hover{background:rgba(255,255,255,.06);color:var(--t);border-color:var(--b2)}
.header-btn.active{background:var(--amber-bg);color:var(--amber);border-color:var(--amber-br)}

#tab-bar{display:flex;border-bottom:1px solid var(--b);flex-shrink:0;overflow-x:auto}
.tab{padding:8px 13px;font-size:10px;color:var(--t2);cursor:pointer;border-bottom:2px solid transparent;white-space:nowrap;transition:all .15s;font-family:var(--font-mono);text-transform:uppercase;letter-spacing:.5px;font-weight:500}
.tab:hover{color:var(--t);background:rgba(255,255,255,.02)}
.tab.active{color:var(--purple);border-bottom-color:var(--purple)}
#tab-content{flex:1;overflow-y:auto;padding:16px}

.panel-section{margin-bottom:20px}
.panel-title{font-family:var(--font-mono);font-size:10px;color:var(--t3);text-transform:uppercase;letter-spacing:1px;margin-bottom:8px;display:flex;align-items:center;gap:6px;font-weight:600}
.panel-title::before{content:'';flex:0 0 3px;height:3px;border-radius:50%;background:var(--purple)}
.panel-value{font-size:13px;color:var(--t)}
.panel-list{list-style:none;padding:0}
.panel-list li{font-size:12px;color:var(--t2);padding:3px 0;font-family:var(--font-mono);display:flex;align-items:center;gap:6px;font-weight:400}
.panel-list li::before{content:'';width:4px;height:4px;border-radius:50%;background:var(--b2);flex-shrink:0}
.panel-card{background:var(--s2);border:1px solid var(--b);border-radius:8px;padding:12px;margin-bottom:8px}
.panel-card-title{font-family:var(--font-heading);font-size:12px;font-weight:600;margin-bottom:4px}
.panel-card-desc{font-size:11px;color:var(--t2);font-family:var(--font-body)}
.panel-tag{display:inline-block;font-family:var(--font-mono);font-size:10px;padding:1px 6px;border-radius:3px;background:var(--s2);color:var(--t2);border:1px solid var(--b);margin:2px;font-weight:400}

.node-detail-header{display:flex;align-items:center;gap:12px;margin-bottom:16px;padding-bottom:12px;border-bottom:1px solid var(--b)}
.node-icon{width:40px;height:40px;border-radius:10px;display:flex;align-items:center;justify-content:center;font-size:18px;flex-shrink:0}
.node-icon.agent{background:var(--purple-bg);border:1px solid var(--purple-br)}
.node-icon.action{background:var(--gray-bg);border:1px solid var(--gray-br)}
.node-icon.gate{background:var(--orange-bg);border:1px solid var(--orange-br)}
.node-icon.orchestrator{background:var(--gold-bg);border:1px solid var(--gold-br)}
.node-detail-name{font-family:var(--font-heading);font-size:16px;font-weight:600}
.node-detail-type{font-family:var(--font-mono);font-size:10px;text-transform:uppercase;letter-spacing:1px;padding:2px 8px;border-radius:4px;font-weight:500}
.node-detail-role{font-size:12px;color:var(--t2);margin-bottom:16px;line-height:1.6}
.detail-row{display:flex;gap:8px;margin-bottom:6px;font-size:12px}
.detail-label{color:var(--t3);min-width:80px;font-family:var(--font-mono);flex-shrink:0;font-weight:500}
.detail-value{color:var(--t);font-family:var(--font-body)}
.tools-group-title{font-family:var(--font-mono);font-size:9px;color:var(--t3);text-transform:uppercase;letter-spacing:.5px;margin:8px 0 4px;font-weight:600}
.tool-chip{display:inline-block;font-family:var(--font-mono);font-size:10px;padding:2px 7px;border-radius:4px;margin:2px;background:var(--s2);color:var(--t2);border:1px solid var(--b);font-weight:400}
.tool-chip.core{background:var(--blue-bg);color:var(--blue);border-color:var(--blue-br)}
.tool-chip.mcp{background:var(--purple-bg);color:var(--purple);border-color:var(--purple-br)}
.tool-chip.skill{background:var(--green-bg);color:var(--green);border-color:var(--green-br)}
.tool-chip.script-tool{background:var(--orange-bg);color:var(--orange);border-color:var(--orange-br)}
.skill-card{background:var(--s2);border:1px solid var(--b);border-radius:8px;padding:10px 12px;margin-bottom:8px}
.skill-card-name{font-family:var(--font-mono);font-size:12px;font-weight:600;color:var(--green);margin-bottom:4px}
.skill-card-desc{font-size:11px;color:var(--t2);line-height:1.5;margin-bottom:6px}
.skill-card-meta{display:flex;flex-wrap:wrap;gap:4px}
.skill-card-agents{font-size:10px;color:var(--t3);margin-top:6px;font-style:italic}
.tool-card{background:var(--s2);border:1px solid var(--b);border-radius:8px;padding:10px 12px;margin-bottom:8px}
.tool-card-name{font-family:var(--font-mono);font-size:12px;font-weight:600;color:var(--orange);margin-bottom:4px}
.tool-card-script{font-family:var(--font-mono);font-size:10px;color:var(--t2);margin-bottom:4px}
.tool-card-desc{font-size:11px;color:var(--t2);line-height:1.5}
.output-chip{display:inline-block;font-family:var(--font-mono);font-size:10px;padding:2px 7px;border-radius:4px;margin:2px;font-weight:500}
.output-chip.pass{background:var(--green-bg);color:var(--green);border:1px solid var(--green-br)}
.output-chip.fail{background:var(--red-bg);color:var(--red);border:1px solid var(--red-br)}
.output-chip.default{background:var(--gray-bg);color:var(--gray);border:1px solid var(--gray-br)}

.node-group{cursor:pointer}
.node-group.dimmed{opacity:.18}
.node-group.highlighted{opacity:1}
.node-label{font-family:var(--font-heading);fill:var(--t);font-size:12px;font-weight:600;text-anchor:middle;dominant-baseline:central;pointer-events:none;letter-spacing:-.2px}
.node-sublabel{font-family:var(--font-mono);fill:var(--t2);font-size:8.5px;text-anchor:middle;dominant-baseline:central;pointer-events:none;letter-spacing:.3px;font-weight:500}
.edge-path{fill:none;stroke-width:1.5}
.edge-path.unconditional{stroke:rgba(255,255,255,.15)}
.edge-path.conditional{stroke:var(--t3);stroke-dasharray:6 4}
.edge-path.failure{stroke:var(--red);stroke-dasharray:6 4;opacity:.7}
.edge-path.loop{stroke:var(--orange);stroke-dasharray:4 4}
.edge-group.dimmed .edge-path{opacity:.06}
.edge-group.dimmed .edge-label-group{opacity:.06}
.edge-group.highlighted .edge-path{stroke-width:2.5;opacity:1}
.edge-group.highlighted .edge-label-group{opacity:1}

@keyframes marchingAnts{from{stroke-dashoffset:0}to{stroke-dashoffset:-20}}
.edge-path.conditional,.edge-path.failure{animation:marchingAnts 4s linear infinite}
@keyframes loopPulse{0%,100%{opacity:.7}50%{opacity:1}}
.edge-path.loop{animation:marchingAnts 4s linear infinite,loopPulse 3s ease-in-out infinite}
.node-group .node-shape{transition:filter .2s}
@keyframes nodeFadeIn{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:translateY(0)}}

#zoom-controls{position:absolute;bottom:16px;right:16px;display:flex;flex-direction:column;gap:4px;z-index:5}
.zoom-btn{width:32px;height:32px;background:var(--s);border:1px solid var(--b);border-radius:6px;color:var(--t2);font-size:16px;cursor:pointer;display:flex;align-items:center;justify-content:center;transition:all .15s;font-family:var(--font-mono)}
.zoom-btn:hover{background:rgba(255,255,255,.06);color:var(--t);border-color:var(--b2)}

#legend{position:absolute;bottom:16px;left:16px;background:var(--s);border:1px solid var(--b);border-radius:8px;padding:12px 16px;z-index:5;font-size:10px;backdrop-filter:blur(8px);max-width:240px}
.legend-section-title{font-family:var(--font-mono);font-size:8px;color:var(--t3);text-transform:uppercase;letter-spacing:1px;margin:6px 0 3px;font-weight:600}
.legend-section-title:first-child{margin-top:0}
.legend-row{display:flex;align-items:center;gap:8px;margin:3px 0}
.legend-swatch{width:12px;height:12px;border-radius:3px;flex-shrink:0}
.legend-line{width:20px;height:0;border-top:2px solid;flex-shrink:0}
.legend-line.dashed{border-top-style:dashed}
.legend-label{color:var(--t2);font-family:var(--font-body);font-size:10px}
.legend-badge{width:12px;height:12px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:7px;font-weight:700;flex-shrink:0}

#load-modal{display:none;position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,.7);backdrop-filter:blur(8px);z-index:100;justify-content:center;align-items:center}
#load-modal.open{display:flex}
.modal-content{background:var(--s);border:1px solid var(--b);border-radius:12px;padding:24px;width:90%;max-width:640px;max-height:80vh;display:flex;flex-direction:column}
.modal-content h3{font-family:var(--font-heading);font-size:16px;margin-bottom:12px;font-weight:600}
.modal-textarea{width:100%;flex:1;min-height:300px;background:var(--bg);border:1px solid var(--b);border-radius:8px;padding:12px;color:var(--t);font-family:var(--font-mono);font-size:12px;resize:none}
.modal-textarea:focus{outline:none;border-color:var(--purple)}
.modal-actions{display:flex;gap:8px;margin-top:12px;justify-content:flex-end}
.modal-btn{padding:6px 16px;border-radius:6px;font-size:12px;cursor:pointer;border:1px solid var(--b);font-family:var(--font-mono);transition:all .15s;font-weight:500}
.modal-btn.primary{background:var(--purple);color:#fff;border-color:var(--purple)}
.modal-btn.primary:hover{filter:brightness(1.15)}
.modal-btn.secondary{background:var(--s2);color:var(--t2)}
.modal-btn.secondary:hover{background:rgba(255,255,255,.06);color:var(--t)}

.node-selected .node-shape{stroke-width:2.5!important;filter:brightness(1.3)!important}
.mini-graph{background:var(--bg);border:1px solid var(--b);border-radius:8px;padding:8px;margin-bottom:16px}
.data-flow-pill{font-family:var(--font-mono);font-size:8px;font-weight:500;letter-spacing:.3px}

::-webkit-scrollbar{width:5px}
::-webkit-scrollbar-track{background:transparent}
::-webkit-scrollbar-thumb{background:rgba(255,255,255,.08);border-radius:3px}
::-webkit-scrollbar-thumb:hover{background:rgba(255,255,255,.14)}

.svg-tooltip{position:absolute;background:var(--s);border:1px solid var(--b);border-radius:6px;padding:6px 10px;font-family:var(--font-mono);font-size:10px;color:var(--cyan);pointer-events:none;z-index:20;white-space:pre-line;backdrop-filter:blur(8px);opacity:0;transition:opacity .15s}
.svg-tooltip.visible{opacity:1}
`;

// ---------------------------------------------------------------------------
// Inline JS  (the full advanced viewer logic)
// ---------------------------------------------------------------------------

const JS = `
// === State ===
let data = null, selectedNode = null, hoveredNode = null;
let transform = { x: 0, y: 0, scale: 1 };
let isPanning = false, panStart = { x: 0, y: 0 };
let nodePositions = {};
let dataFlowEnabled = false;
let isHorizontal = false;

// === Constants ===
const NODE_W = 160, NODE_H = 56, ORCH_W = 200, ORCH_H = 60;
const GATE_W = 120, GATE_H = 44, ACTION_W = 140, ACTION_H = 54;
const TRIGGER_W = 100, TRIGGER_H = 28;
const COL_GAP = 70, ROW_GAP = 90;

const FOLDER_COLORS = {
  'explore': '#60a5fa', 'plan': '#a78bfa', 'build': '#fb923c',
  'qa': '#4ade80', 'security': '#f87171', 'design': '#f472b6',
  'meta-review': '#fbbf24', 'ticket': '#94a3b8'
};
function folderColor(path) {
  const folder = (path || '').split('/')[0].replace('/*','');
  return FOLDER_COLORS[folder] || '#94a3b8';
}

// === Color helpers ===
function modelColor(model) {
  if (!model) return { main: '#94a3b8', bg: 'rgba(148,163,184,.08)', br: 'rgba(148,163,184,.2)' };
  switch (model.toLowerCase()) {
    case 'opus': return { main: '#a78bfa', bg: 'rgba(167,139,250,.12)', br: 'rgba(167,139,250,.35)' };
    case 'sonnet': return { main: '#60a5fa', bg: 'rgba(96,165,250,.12)', br: 'rgba(96,165,250,.35)' };
    case 'haiku': return { main: '#4ade80', bg: 'rgba(74,222,128,.12)', br: 'rgba(74,222,128,.35)' };
    default: return { main: '#94a3b8', bg: 'rgba(148,163,184,.08)', br: 'rgba(148,163,184,.2)' };
  }
}
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
    case 'agent': return '\\u2726'; case 'action': return '\\u25C7';
    case 'gate': return '\\u2B21'; case 'orchestrator': return '\\u2B22';
    default: return '\\u25CB';
  }
}

// === Layout engine ===
function nodeSize(node) {
  if (node.type === 'orchestrator') return { w: ORCH_W, h: ORCH_H };
  if (node.type === 'gate') return { w: GATE_W, h: GATE_H };
  if (node.type === 'action') return { w: ACTION_W, h: ACTION_H };
  return { w: NODE_W, h: NODE_H };
}
function isManualNode(node) { return node.invocation === 'manual'; }

function layoutNodes(nodes, edges) {
  const positions = {};
  const nodeMap = {};
  nodes.forEach(n => nodeMap[n.id] = n);

  const orchestratorNode = nodes.find(n => n.type === 'orchestrator');
  const gateNodes = nodes.filter(n => n.type === 'gate');
  const gateIds = new Set(gateNodes.map(g => g.id));
  const manualNodes = nodes.filter(n => isManualNode(n));
  const manualIds = new Set(manualNodes.map(n => n.id));

  const flowNodeIds = new Set();
  const forwardEdges = edges.filter(e => !e.maxIterations);
  forwardEdges.forEach(e => { flowNodeIds.add(e.from); flowNodeIds.add(e.to); });
  gateIds.forEach(id => flowNodeIds.delete(id));
  manualIds.forEach(id => flowNodeIds.delete(id));

  const undirAdj = {};
  flowNodeIds.forEach(id => { undirAdj[id] = new Set(); });
  forwardEdges.forEach(e => {
    if (flowNodeIds.has(e.from) && flowNodeIds.has(e.to)) {
      undirAdj[e.from].add(e.to); undirAdj[e.to].add(e.from);
    }
  });
  edges.filter(e => e.maxIterations).forEach(e => {
    if (flowNodeIds.has(e.from) && flowNodeIds.has(e.to)) {
      undirAdj[e.from].add(e.to); undirAdj[e.to].add(e.from);
    }
  });

  const visited = new Set();
  const subgraphs = [];
  flowNodeIds.forEach(id => {
    if (visited.has(id)) return;
    const component = [];
    const bfsQ = [id];
    while (bfsQ.length > 0) {
      const cur = bfsQ.shift();
      if (visited.has(cur)) continue;
      visited.add(cur); component.push(cur);
      (undirAdj[cur] || new Set()).forEach(nb => { if (!visited.has(nb)) bfsQ.push(nb); });
    }
    subgraphs.push(component);
  });
  subgraphs.sort((a, b) => b.length - a.length || a[0].localeCompare(b[0]));

  function rankSubgraph(sgNodeIds) {
    const sgSet = new Set(sgNodeIds);
    const adj = {}, inDeg = {};
    sgSet.forEach(id => { adj[id] = []; inDeg[id] = 0; });
    forwardEdges.forEach(e => {
      if (sgSet.has(e.from) && sgSet.has(e.to)) {
        adj[e.from].push(e.to); inDeg[e.to] = (inDeg[e.to] || 0) + 1;
      }
    });
    const rank = {};
    const queue = [];
    sgSet.forEach(id => { if (!inDeg[id]) { queue.push(id); rank[id] = 0; } });
    const processed = new Set();
    while (queue.length > 0) {
      const curr = queue.shift();
      if (processed.has(curr)) continue;
      const allParentsProcessed = forwardEdges
        .filter(e => e.to === curr && sgSet.has(e.from))
        .every(e => processed.has(e.from));
      if (!allParentsProcessed && processed.size > 0) { queue.push(curr); continue; }
      processed.add(curr);
      (adj[curr] || []).forEach(next => {
        rank[next] = Math.max(rank[next] || 0, rank[curr] + 1);
        if (!queue.includes(next)) queue.push(next);
      });
    }
    sgSet.forEach(id => { if (rank[id] === undefined) rank[id] = 0; });
    return rank;
  }

  const SUBGRAPH_GAP = 160;
  let globalStartY = 40;
  if (orchestratorNode) {
    const sz = nodeSize(orchestratorNode);
    positions[orchestratorNode.id] = { x: 500, y: globalStartY, w: sz.w, h: sz.h };
    globalStartY += sz.h + ROW_GAP;
  }

  let columnX = 500;
  const subgraphCenters = [];
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

  if (orchestratorNode && subgraphCenters.length > 0) {
    positions[orchestratorNode.id].x = subgraphCenters[0];
  }

  gateNodes.forEach(gate => {
    if (gate.after && gate.before && gate.after === gate.before && positions[gate.after]) {
      const refPos = positions[gate.after];
      const sz = nodeSize(gate);
      positions[gate.id] = { x: refPos.x, y: refPos.y + refPos.h + ROW_GAP / 2, w: sz.w, h: sz.h };
    } else if (gate.after && gate.before && positions[gate.after] && positions[gate.before]) {
      const afterPos = positions[gate.after], beforePos = positions[gate.before];
      const sz = nodeSize(gate);
      positions[gate.id] = {
        x: (afterPos.x + beforePos.x) / 2,
        y: afterPos.y + afterPos.h + (beforePos.y - afterPos.y - afterPos.h) / 2 - sz.h / 2,
        w: sz.w, h: sz.h
      };
    } else if (gate.after && positions[gate.after]) {
      const afterPos = positions[gate.after];
      const sz = nodeSize(gate);
      positions[gate.id] = {
        x: afterPos.x + afterPos.w / 2 + sz.w / 2 + 30,
        y: afterPos.y + afterPos.h / 2 - sz.h / 2,
        w: sz.w, h: sz.h
      };
    }
  });

  if (manualNodes.length > 0) {
    let maxRightX = 500;
    Object.entries(positions).forEach(([id, p]) => { maxRightX = Math.max(maxRightX, p.x + p.w / 2); });
    const sidebarX = maxRightX + 120;
    let sideY = 80;
    manualNodes.forEach(n => {
      const sz = nodeSize(n);
      positions[n.id] = { x: sidebarX, y: sideY, w: sz.w, h: sz.h };
      sideY += sz.h + 24;
    });
  }

  const placed = new Set(Object.keys(positions));
  const disconnected = nodes.filter(n => n.type !== 'orchestrator' && !placed.has(n.id));
  if (disconnected.length > 0) {
    let maxRightX = 0;
    Object.values(positions).forEach(p => { maxRightX = Math.max(maxRightX, p.x + p.w / 2); });
    const sideX = maxRightX + 120;
    let sideY = 40;
    disconnected.forEach(n => {
      const sz = nodeSize(n);
      positions[n.id] = { x: sideX, y: sideY, w: sz.w, h: sz.h };
      sideY += sz.h + 24;
    });
  }
  return positions;
}

// === SVG rendering ===
function renderGraph() {
  if (!data) return;
  const svg = document.getElementById('graph-svg');
  const container = document.getElementById('graph-container');
  const rect = container.getBoundingClientRect();

  if (data.hooks && data.hooks.length > 0) {
    data.nodes.forEach(n => {
      const matched = data.hooks.filter(hk => {
        if (!hk.matcher) return false;
        const m = hk.matcher.toLowerCase();
        return (n.id && n.id.toLowerCase().includes(m)) || (n.label && n.label.toLowerCase().includes(m));
      });
      if (matched.length > 0) {
        if (!n.hooks) n.hooks = [];
        matched.forEach(hk => {
          if (!n.hooks.some(h => h.name === hk.name)) n.hooks.push({ ...hk, global: true });
        });
      }
    });
  }

  nodePositions = layoutNodes(data.nodes, data.edges);
  const nodeMap = {};
  data.nodes.forEach(n => nodeMap[n.id] = n);

  if (isHorizontal) {
    let minNewX = Infinity;
    Object.keys(nodePositions).forEach(id => {
      const p = nodePositions[id];
      const newX = p.y + p.h / 2, newY = p.x;
      p.x = newX; p.y = newY;
      if (newX < minNewX) minNewX = newX;
    });
    Object.keys(nodePositions).forEach(id => {
      const p = nodePositions[id];
      p.x = minNewX + (p.x - minNewX) * 1.4;
    });
  }

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  Object.values(nodePositions).forEach(p => {
    minX = Math.min(minX, p.x - p.w / 2 - 60); minY = Math.min(minY, p.y - 60);
    maxX = Math.max(maxX, p.x + p.w / 2 + 60); maxY = Math.max(maxY, p.y + p.h + 60);
  });
  const graphW = maxX - minX + 200, graphH = maxY - minY + 100;
  svg.setAttribute('width', Math.max(graphW, rect.width));
  svg.setAttribute('height', Math.max(graphH, rect.height));

  let s = '';
  s += '<defs>';
  s += '<marker id="arrow" viewBox="0 0 10 6" refX="10" refY="3" markerWidth="8" markerHeight="5" orient="auto-start-reverse"><path d="M0,0 L10,3 L0,6 Z" fill="rgba(255,255,255,.15)"/></marker>';
  s += '<marker id="arrow-cond" viewBox="0 0 10 6" refX="10" refY="3" markerWidth="8" markerHeight="5" orient="auto-start-reverse"><path d="M0,0 L10,3 L0,6 Z" fill="#5858a0"/></marker>';
  s += '<marker id="arrow-fail" viewBox="0 0 10 6" refX="10" refY="3" markerWidth="8" markerHeight="5" orient="auto-start-reverse"><path d="M0,0 L10,3 L0,6 Z" fill="#f87171"/></marker>';
  s += '<marker id="arrow-loop" viewBox="0 0 10 6" refX="10" refY="3" markerWidth="8" markerHeight="5" orient="auto-start-reverse"><path d="M0,0 L10,3 L0,6 Z" fill="#fb923c"/></marker>';
  s += '<marker id="arrow-trigger" viewBox="0 0 10 6" refX="10" refY="3" markerWidth="8" markerHeight="5" orient="auto-start-reverse"><path d="M0,0 L10,3 L0,6 Z" fill="#22d3ee"/></marker>';
  s += '<filter id="glow-purple"><feDropShadow dx="0" dy="0" stdDeviation="4" flood-color="#a78bfa" flood-opacity=".4"/></filter>';
  s += '<filter id="glow-blue"><feDropShadow dx="0" dy="0" stdDeviation="4" flood-color="#60a5fa" flood-opacity=".4"/></filter>';
  s += '<filter id="glow-green"><feDropShadow dx="0" dy="0" stdDeviation="4" flood-color="#4ade80" flood-opacity=".4"/></filter>';
  s += '<filter id="glow-orange"><feDropShadow dx="0" dy="0" stdDeviation="4" flood-color="#fb923c" flood-opacity=".4"/></filter>';
  s += '<filter id="glow-gold"><feDropShadow dx="0" dy="0" stdDeviation="4" flood-color="#fbbf24" flood-opacity=".4"/></filter>';
  s += '<filter id="glow-gray"><feDropShadow dx="0" dy="0" stdDeviation="4" flood-color="#94a3b8" flood-opacity=".3"/></filter>';
  s += '<filter id="glow-cyan"><feDropShadow dx="0" dy="0" stdDeviation="4" flood-color="#22d3ee" flood-opacity=".4"/></filter>';
  s += '</defs>';

  s += '<g id="graph-transform" transform="translate(' + transform.x + ',' + transform.y + ') scale(' + transform.scale + ')">';

  const nodeRanks = {};
  data.nodes.forEach(n => {
    const pos = nodePositions[n.id];
    if (pos) nodeRanks[n.id] = Math.round(pos.y / ROW_GAP);
  });

  // --- Edges ---
  const edgeLabelCount = {};
  data.edges.forEach(edge => {
    const fromPos = nodePositions[edge.from], toPos = nodePositions[edge.to];
    if (!fromPos || !toPos) return;

    const isFailure = edge.condition && edge.condition.includes('fail');
    const isLoop = edge.maxIterations != null;
    const isConditional = edge.condition != null;

    let edgeClass = 'unconditional', markerEnd = 'url(#arrow)';
    if (isLoop) { edgeClass = 'loop'; markerEnd = 'url(#arrow-loop)'; }
    else if (isFailure) { edgeClass = 'failure'; markerEnd = 'url(#arrow-fail)'; }
    else if (isConditional) { edgeClass = 'conditional'; markerEnd = 'url(#arrow-cond)'; }

    const fromY = fromPos.y + fromPos.h, toY = toPos.y;
    const fromX = fromPos.x, toX = toPos.x;

    let pathD;
    const isBackEdge = toPos.y <= fromPos.y + fromPos.h;
    if (isBackEdge && (isLoop || isFailure)) {
      const allPos = Object.values(nodePositions);
      let maxRight = 0;
      allPos.forEach(p => { maxRight = Math.max(maxRight, p.x + p.w / 2); });
      const loopX = maxRight + 60;
      const startY = fromPos.y + fromPos.h / 2, endY = toPos.y + toPos.h / 2;
      const startX = fromPos.x + fromPos.w / 2, endX = toPos.x + toPos.w / 2;
      pathD = 'M' + startX + ',' + startY + ' C' + loopX + ',' + startY + ' ' + loopX + ',' + endY + ' ' + endX + ',' + endY;
    } else {
      const midY = fromY + (toY - fromY) / 2;
      pathD = 'M' + fromX + ',' + fromY + ' C' + fromX + ',' + midY + ' ' + toX + ',' + midY + ' ' + toX + ',' + toY;
    }

    s += '<g class="edge-group" data-from="' + edge.from + '" data-to="' + edge.to + '">';
    s += '<path d="' + pathD + '" class="edge-path ' + edgeClass + '" marker-end="' + markerEnd + '"/>';

    if (edge.condition || isLoop) {
      const isBack = toPos.y <= fromPos.y + fromPos.h;
      let labelX, labelY;
      if (isBack && (isLoop || isFailure)) {
        const allPos = Object.values(nodePositions);
        let mr = 0; allPos.forEach(p => { mr = Math.max(mr, p.x + p.w / 2); });
        labelX = mr + 70; labelY = (fromPos.y + toPos.y + toPos.h) / 2;
      } else {
        labelX = (fromX + toX) / 2 + 10; labelY = fromY + (toY - fromY) / 2;
      }
      let label = '';
      if (edge.condition) label = edge.condition.replace('orchestrator.', '').replace('qa.', '').replace(' == ', '=');
      if (isLoop) label += (label ? ' ' : '') + 'max ' + edge.maxIterations;
      if (label) {
        if (!edgeLabelCount[edge.from]) edgeLabelCount[edge.from] = 0;
        const labelIdx = edgeLabelCount[edge.from]++;
        const offsetY = labelIdx * 18;
        const finalY = labelY + offsetY;
        const labelLen = label.length * 5.5 + 16;
        const pillH = 16, pillR = 8;
        let pillFill = 'rgba(88,88,160,.15)', pillStroke = 'rgba(88,88,160,.3)', textFill = '#8888a8';
        if (isLoop) { pillFill = 'rgba(251,146,60,.12)'; pillStroke = 'rgba(251,146,60,.3)'; textFill = '#fb923c'; }
        else if (isFailure) { pillFill = 'rgba(248,113,113,.12)'; pillStroke = 'rgba(248,113,113,.3)'; textFill = '#f87171'; }
        s += '<g class="edge-label-group">';
        s += '<rect x="' + (labelX - labelLen/2) + '" y="' + (finalY - pillH/2) + '" width="' + labelLen + '" height="' + pillH + '" rx="' + pillR + '" fill="' + pillFill + '" stroke="' + pillStroke + '" stroke-width="0.5"/>';
        let iconOffset = 0;
        if (isLoop) {
          s += '<text x="' + (labelX - labelLen/2 + 6) + '" y="' + (finalY + 1) + '" font-size="8" fill="' + textFill + '" dominant-baseline="central">\\u21BB</text>';
          iconOffset = 10;
        } else if (isFailure) {
          s += '<text x="' + (labelX - labelLen/2 + 6) + '" y="' + (finalY + 1) + '" font-size="8" fill="#f87171" dominant-baseline="central" font-weight="700">\\u2717</text>';
          iconOffset = 10;
        }
        s += '<text x="' + (labelX + iconOffset/2) + '" y="' + (finalY + 1) + '" font-family="monospace" font-size="8.5" fill="' + textFill + '" text-anchor="middle" dominant-baseline="central" font-weight="500">' + esc(label) + '</text>';
        s += '</g>';
      }
    }
    s += '</g>';
  });

  // Gate advisory connectors
  data.nodes.filter(n => n.type === 'gate' && n.after && !n.before).forEach(gate => {
    const gatePos = nodePositions[gate.id], afterPos = nodePositions[gate.after];
    if (!gatePos || !afterPos) return;
    const fX = afterPos.x + afterPos.w / 2, fY = afterPos.y + afterPos.h / 2;
    const tX = gatePos.x - gatePos.w / 2, tY = gatePos.y + gatePos.h / 2;
    s += '<g class="edge-group" data-from="' + gate.after + '" data-to="' + gate.id + '">';
    s += '<path d="M' + fX + ',' + fY + ' L' + tX + ',' + tY + '" class="edge-path conditional" stroke-dasharray="3 3" marker-end="url(#arrow-cond)" opacity="0.3"/>';
    s += '</g>';
  });

  // --- Trigger pills ---
  if (data.triggers && data.triggers.length > 0) {
    const fwdEdges = data.edges.filter(e => !e.maxIterations);
    const allFlowIds = new Set();
    fwdEdges.forEach(e => { allFlowIds.add(e.from); allFlowIds.add(e.to); });
    data.nodes.filter(n => isManualNode(n)).forEach(n => allFlowIds.delete(n.id));
    data.nodes.filter(n => n.type === 'gate').forEach(n => allFlowIds.delete(n.id));
    const inDegree = {};
    allFlowIds.forEach(id => { inDegree[id] = 0; });
    fwdEdges.forEach(e => { if (allFlowIds.has(e.to)) inDegree[e.to] = (inDegree[e.to] || 0) + 1; });
    const rootNodes = [...allFlowIds].filter(id => !inDegree[id] || inDegree[id] === 0);
    const triggerEntryMap = {};
    data.triggers.forEach(trigger => {
      const name = trigger.name;
      let entry = rootNodes.find(r => r.startsWith(name + '-'));
      if (!entry && name === 'ship') entry = rootNodes.find(r => r === 'intake');
      if (!entry) entry = rootNodes.find(r => r === name);
      if (!entry && rootNodes.length > 0) entry = rootNodes[0];
      if (entry) triggerEntryMap[name] = entry;
    });
    data.triggers.forEach(trigger => {
      const entryId = triggerEntryMap[trigger.name];
      if (!entryId) return;
      const entryPos = nodePositions[entryId];
      if (!entryPos) return;
      const tw = Math.max(TRIGGER_W, trigger.pattern.length * 7 + 20);
      const th = TRIGGER_H;
      const tx = entryPos.x, ty = entryPos.y - th - 30;
      const fromTY = ty + th, toTY = entryPos.y;
      const midTY = fromTY + (toTY - fromTY) / 2;
      s += '<path d="M' + tx + ',' + fromTY + ' C' + tx + ',' + midTY + ' ' + entryPos.x + ',' + midTY + ' ' + entryPos.x + ',' + toTY + '" class="edge-path" stroke="#22d3ee" stroke-width="1" stroke-dasharray="4 3" fill="none" opacity="0.5" marker-end="url(#arrow-trigger)"/>';
      s += '<g class="trigger-pill" style="animation:nodeFadeIn .4s ease-out 0ms both">';
      s += '<rect x="' + (tx - tw/2) + '" y="' + ty + '" width="' + tw + '" height="' + th + '" rx="' + (th/2) + '" fill="rgba(34,211,238,.08)" stroke="rgba(34,211,238,.35)" stroke-width="1"/>';
      s += '<text x="' + tx + '" y="' + (ty + th/2 + 1) + '" text-anchor="middle" dominant-baseline="central" font-family="monospace" font-size="10" fill="#22d3ee" font-weight="600">' + esc(trigger.pattern) + '</text>';
      s += '</g>';
    });
  }

  // --- Data flow overlay ---
  if (dataFlowEnabled) s += renderDataFlowOverlay(nodeMap);

  // --- Manual agents label ---
  const manualNodesArr = data.nodes.filter(n => isManualNode(n));
  if (manualNodesArr.length > 0) {
    const firstManual = nodePositions[manualNodesArr[0].id];
    if (firstManual) {
      s += '<text x="' + firstManual.x + '" y="' + (firstManual.y - 20) + '" text-anchor="middle" font-family="monospace" font-size="9" fill="rgba(255,255,255,.25)" letter-spacing="2" font-weight="600">MANUAL AGENTS</text>';
    }
  }

  // --- Nodes ---
  data.nodes.forEach(node => {
    const pos = nodePositions[node.id];
    if (!pos) return;
    const isSelected = selectedNode === node.id;
    const isManual = isManualNode(node);
    const colors = node.type === 'agent' ? modelColor(node.model) : typeColor(node.type);
    const glowFilter = getGlowFilter(node);
    const staggerDelay = (nodeRanks[node.id] || 0) * 50;

    s += '<g class="node-group' + (isSelected ? ' node-selected' : '') + '" data-id="' + node.id + '" style="animation:nodeFadeIn .4s ease-out ' + staggerDelay + 'ms both" onmouseenter="onNodeHover(\\'' + node.id + '\\')" onmouseleave="onNodeLeave()" onclick="onNodeClick(\\'' + node.id + '\\')">';

    const x = pos.x - pos.w / 2, y = pos.y;
    const strokeDash = isManual ? 'stroke-dasharray="4 3"' : '';
    const dimOpacity = isManual ? 'opacity="0.7"' : '';

    if (node.type === 'orchestrator') {
      s += '<rect class="node-shape" x="' + x + '" y="' + y + '" width="' + pos.w + '" height="' + pos.h + '" rx="8" fill="' + colors.bg + '" stroke="' + colors.main + '" stroke-width="' + (isSelected ? 2.5 : 1.5) + '" data-glow="' + glowFilter + '" ' + dimOpacity + '/>';
      s += '<rect x="' + x + '" y="' + y + '" width="' + pos.w + '" height="3" rx="8" fill="' + colors.main + '" opacity="0.5"/>';
    } else if (node.type === 'gate') {
      const cx = pos.x, cy = y + pos.h / 2;
      const hw = pos.w / 2, hh = pos.h / 2;
      const hex = cx + ',' + (cy - hh) + ' ' + (cx + hw) + ',' + (cy - hh * 0.45) + ' ' + (cx + hw) + ',' + (cy + hh * 0.45) + ' ' + cx + ',' + (cy + hh) + ' ' + (cx - hw) + ',' + (cy + hh * 0.45) + ' ' + (cx - hw) + ',' + (cy - hh * 0.45);
      const gateDash = node.behavior === 'advisory' ? 'stroke-dasharray="4 3"' : '';
      s += '<polygon class="node-shape" points="' + hex + '" fill="' + colors.bg + '" stroke="' + colors.main + '" stroke-width="' + (isSelected ? 2.5 : 1) + '" ' + gateDash + ' data-glow="' + glowFilter + '"/>';
    } else if (node.type === 'action') {
      const cx = pos.x, cy = y + pos.h / 2;
      const hw = pos.w / 2, hh = pos.h / 2;
      const d = 'M' + cx + ',' + (cy - hh) + ' Q' + (cx + hw * 0.6) + ',' + (cy - hh * 0.4) + ' ' + (cx + hw) + ',' + cy + ' Q' + (cx + hw * 0.6) + ',' + (cy + hh * 0.4) + ' ' + cx + ',' + (cy + hh) + ' Q' + (cx - hw * 0.6) + ',' + (cy + hh * 0.4) + ' ' + (cx - hw) + ',' + cy + ' Q' + (cx - hw * 0.6) + ',' + (cy - hh * 0.4) + ' ' + cx + ',' + (cy - hh) + ' Z';
      s += '<path class="node-shape" d="' + d + '" fill="' + colors.bg + '" stroke="' + colors.main + '" stroke-width="' + (isSelected ? 2.5 : 1) + '" data-glow="' + glowFilter + '"/>';
    } else {
      s += '<rect class="node-shape" x="' + x + '" y="' + y + '" width="' + pos.w + '" height="' + pos.h + '" rx="12" fill="' + colors.bg + '" stroke="' + colors.main + '" stroke-width="' + (isSelected ? 2.5 : 1) + '" ' + strokeDash + ' ' + dimOpacity + ' data-glow="' + glowFilter + '"/>';
    }

    const labelY = y + pos.h / 2 - (node.type === 'agent' && node.phase != null ? 4 : 0);
    s += '<text class="node-label" x="' + pos.x + '" y="' + labelY + '" fill="' + colors.main + '" ' + dimOpacity + '>' + esc(node.label) + '</text>';

    if (node.type === 'agent' && node.phase != null) {
      s += '<text class="node-sublabel" x="' + pos.x + '" y="' + (labelY + 14) + '">Phase ' + node.phase + '</text>';
    } else if (node.type === 'action' && node.kind) {
      s += '<text class="node-sublabel" x="' + pos.x + '" y="' + (labelY + 13) + '">' + node.kind + '</text>';
    } else if (node.type === 'gate') {
      s += '<text class="node-sublabel" x="' + pos.x + '" y="' + (labelY + 11) + '">gate</text>';
    }

    let badgeX = x + pos.w - 4;
    const badgeY = y - 2;

    if (node.hooks && node.hooks.length > 0) {
      s += '<g class="hook-badge" onmouseenter="showTooltip(event, \\'' + node.hooks.map(h=>h.name).join('\\\\n') + '\\')" onmouseleave="hideTooltip()">';
      s += '<circle cx="' + (x + 4) + '" cy="' + badgeY + '" r="7" fill="rgba(34,211,238,.15)" stroke="rgba(34,211,238,.35)" stroke-width="0.5"/>';
      s += '<text x="' + (x + 4) + '" y="' + (badgeY + 1) + '" text-anchor="middle" dominant-baseline="central" font-size="9" fill="#22d3ee">\\u26A1</text>';
      s += '</g>';
    }

    if (node.skills && node.skills.length > 0) {
      const skBadgeX = x + 4 + (node.hooks && node.hooks.length > 0 ? 16 : 0);
      s += '<g onmouseenter="showTooltip(event, \\'' + node.skills.join('\\\\n') + '\\')" onmouseleave="hideTooltip()">';
      s += '<circle cx="' + skBadgeX + '" cy="' + badgeY + '" r="7" fill="rgba(74,222,128,.15)" stroke="rgba(74,222,128,.35)" stroke-width="0.5"/>';
      s += '<text x="' + skBadgeX + '" y="' + (badgeY + 1) + '" text-anchor="middle" dominant-baseline="central" font-size="8" fill="#4ade80" font-weight="700" font-family="monospace">S</text>';
      s += '</g>';
    }

    if (node.behavior === 'advisory') {
      s += '<circle cx="' + badgeX + '" cy="' + badgeY + '" r="6" fill="rgba(251,191,36,.15)" stroke="rgba(251,191,36,.35)" stroke-width="0.5"/>';
      s += '<text x="' + badgeX + '" y="' + (badgeY + 1) + '" text-anchor="middle" dominant-baseline="central" font-size="7" fill="#fbbf24" font-weight="700" font-family="monospace">A</text>';
      badgeX -= 16;
    }
    if (isManual) {
      s += '<circle cx="' + badgeX + '" cy="' + badgeY + '" r="6" fill="rgba(148,163,184,.12)" stroke="rgba(148,163,184,.25)" stroke-width="0.5"/>';
      s += '<text x="' + badgeX + '" y="' + (badgeY + 1) + '" text-anchor="middle" dominant-baseline="central" font-size="7" fill="#94a3b8" font-weight="700" font-family="monospace">M</text>';
      badgeX -= 16;
    }

    if (node.scale) {
      const sc = node.scale;
      let scaleLabel;
      if (sc.mode === 'fixed') scaleLabel = '\\u00D7' + sc.min;
      else if (sc.mode === 'config') scaleLabel = '\\u00D7?';
      else scaleLabel = '\\u00D7' + sc.min + '\\u2013' + sc.max;
      const scW = scaleLabel.length * 5.5 + 10;
      const scX = badgeX - scW / 2 + 2;
      const scY = badgeY - 7;
      s += '<rect x="' + scX + '" y="' + scY + '" width="' + scW + '" height="14" rx="7" fill="rgba(34,211,238,.12)" stroke="rgba(34,211,238,.35)" stroke-width="0.5"/>';
      s += '<text x="' + (scX + scW / 2) + '" y="' + (scY + 7.5) + '" text-anchor="middle" dominant-baseline="central" font-family="monospace" font-size="8.5" fill="#22d3ee" font-weight="600">' + esc(scaleLabel) + '</text>';
    }

    s += '</g>';
  });

  s += '</g>';
  svg.innerHTML = s;
  if (transform.x === 0 && transform.y === 0 && transform.scale === 1) zoomFit();
  renderLegend();
}

function getGlowFilter(node) {
  if (node.type === 'orchestrator') return 'glow-gold';
  if (node.type === 'gate') return 'glow-orange';
  if (node.type === 'action') return 'glow-gray';
  const m = (node.model || '').toLowerCase();
  if (m === 'opus') return 'glow-purple';
  if (m === 'sonnet') return 'glow-blue';
  if (m === 'haiku') return 'glow-green';
  return 'glow-gray';
}

// === Data Flow Overlay ===
function renderDataFlowOverlay(nodeMap) {
  let s = '<g class="data-flow-layer" opacity="0.6">';
  const artifacts = new Map();
  data.nodes.forEach(node => {
    (node.reads || []).forEach(path => {
      if (!artifacts.has(path)) artifacts.set(path, { readers: new Set(), writers: new Set() });
      artifacts.get(path).readers.add(node.id);
    });
    (node.writes || []).forEach(path => {
      if (!artifacts.has(path)) artifacts.set(path, { readers: new Set(), writers: new Set() });
      artifacts.get(path).writers.add(node.id);
    });
  });
  let artifactIndex = 0;
  artifacts.forEach((info, path) => {
    const color = folderColor(path);
    const writers = [...info.writers].filter(id => nodePositions[id]);
    const readers = [...info.readers].filter(id => nodePositions[id]);
    if (writers.length === 0 || readers.length === 0) { artifactIndex++; return; }
    writers.forEach(wId => {
      readers.forEach(rId => {
        if (wId === rId) return;
        const wPos = nodePositions[wId], rPos = nodePositions[rId];
        const wx = wPos.x, wy = wPos.y + wPos.h / 2;
        const rx = rPos.x, ry = rPos.y + rPos.h / 2;
        const offset = 4 + (artifactIndex % 3) * 3;
        const midX = (wx + rx) / 2 + offset * (artifactIndex % 2 === 0 ? 1 : -1);
        s += '<path d="M' + (wx + wPos.w/2 + 4) + ',' + wy + ' Q' + (midX + 20) + ',' + wy + ' ' + midX + ',' + ((wy + ry) / 2) + '" fill="none" stroke="' + color + '" stroke-width="1" opacity="0.5"/>';
        s += '<path d="M' + midX + ',' + ((wy + ry) / 2) + ' Q' + (midX - 20) + ',' + ry + ' ' + (rx - rPos.w/2 - 4) + ',' + ry + '" fill="none" stroke="' + color + '" stroke-width="1" stroke-dasharray="3 2" opacity="0.5"/>';
        const pillPath = path.length > 14 ? path.substring(0, 12) + '..' : path;
        const pw = pillPath.length * 5.2 + 10;
        const py = (wy + ry) / 2;
        s += '<rect x="' + (midX - pw/2) + '" y="' + (py - 7) + '" width="' + pw + '" height="14" rx="7" fill="' + color + '" opacity="0.12" stroke="' + color + '" stroke-width="0.5" stroke-opacity="0.3"/>';
        s += '<text x="' + midX + '" y="' + (py + 1) + '" class="data-flow-pill" text-anchor="middle" dominant-baseline="central" fill="' + color + '" opacity="0.8">' + esc(pillPath) + '</text>';
      });
    });
    artifactIndex++;
  });
  s += '</g>';
  return s;
}

// === Legend ===
function renderLegend() {
  const el = document.getElementById('legend');
  let h = '';
  h += '<div class="legend-section-title">Nodes</div>';
  h += '<div class="legend-row"><div class="legend-swatch" style="background:rgba(167,139,250,.12);border:1px solid rgba(167,139,250,.25);border-radius:3px"></div><span class="legend-label">Agent (Opus)</span></div>';
  h += '<div class="legend-row"><div class="legend-swatch" style="background:rgba(96,165,250,.12);border:1px solid rgba(96,165,250,.25);border-radius:3px"></div><span class="legend-label">Agent (Sonnet)</span></div>';
  h += '<div class="legend-row"><div class="legend-swatch" style="background:rgba(74,222,128,.12);border:1px solid rgba(74,222,128,.25);border-radius:3px"></div><span class="legend-label">Agent (Haiku)</span></div>';
  h += '<div class="legend-row"><div class="legend-swatch" style="background:rgba(148,163,184,.08);border:1px solid rgba(148,163,184,.2);border-radius:3px"></div><span class="legend-label">Action</span></div>';
  h += '<div class="legend-row"><div class="legend-swatch" style="background:rgba(251,146,60,.10);border:1px solid rgba(251,146,60,.25);clip-path:polygon(50% 0%,100% 25%,100% 75%,50% 100%,0% 75%,0% 25%);border-radius:0"></div><span class="legend-label">Gate</span></div>';
  h += '<div class="legend-row"><div class="legend-swatch" style="background:rgba(251,191,36,.10);border:1px solid rgba(251,191,36,.25);border-radius:3px"></div><span class="legend-label">Orchestrator</span></div>';
  h += '<div class="legend-row"><div class="legend-swatch" style="background:rgba(34,211,238,.08);border:1px solid rgba(34,211,238,.35);border-radius:8px"></div><span class="legend-label">Trigger</span></div>';
  h += '<div class="legend-section-title" style="margin-top:8px">Badges</div>';
  h += '<div class="legend-row"><div class="legend-badge" style="background:rgba(34,211,238,.15);border:1px solid rgba(34,211,238,.35);color:#22d3ee;font-size:8px">\\u26A1</div><span class="legend-label">Has Hooks</span></div>';
  h += '<div class="legend-row"><div class="legend-badge" style="background:rgba(251,191,36,.15);border:1px solid rgba(251,191,36,.35);color:#fbbf24;font-size:7px;font-weight:700">A</div><span class="legend-label">Advisory</span></div>';
  h += '<div class="legend-row"><div class="legend-badge" style="background:rgba(148,163,184,.12);border:1px solid rgba(148,163,184,.25);color:#94a3b8;font-size:7px;font-weight:700">M</div><span class="legend-label">Manual</span></div>';
  h += '<div class="legend-section-title" style="margin-top:8px">Edges</div>';
  h += '<div class="legend-row"><div class="legend-line" style="border-color:rgba(255,255,255,.15)"></div><span class="legend-label">Unconditional</span></div>';
  h += '<div class="legend-row"><div class="legend-line dashed" style="border-color:#5858a0"></div><span class="legend-label">Conditional</span></div>';
  h += '<div class="legend-row"><div class="legend-line dashed" style="border-color:#f87171"></div><span class="legend-label">Failure</span></div>';
  h += '<div class="legend-row"><div class="legend-line dashed" style="border-color:#fb923c"></div><span class="legend-label">Loop (max N)</span></div>';
  if (dataFlowEnabled) {
    h += '<div class="legend-section-title" style="margin-top:8px">Data Flow</div>';
    h += '<div class="legend-row"><div class="legend-line" style="border-color:#f59e0b"></div><span class="legend-label">Active</span></div>';
  }
  el.innerHTML = h;
}

// === Tooltip ===
function showTooltip(evt, text) {
  const tip = document.getElementById('tooltip');
  const container = document.getElementById('graph-container');
  const r = container.getBoundingClientRect();
  tip.textContent = text;
  tip.style.left = (evt.clientX - r.left + 12) + 'px';
  tip.style.top = (evt.clientY - r.top - 8) + 'px';
  tip.classList.add('visible');
}
function hideTooltip() { document.getElementById('tooltip').classList.remove('visible'); }

// === Interaction ===
function onNodeClick(id) {
  selectedNode = id;
  document.querySelectorAll('.node-group').forEach(g => g.classList.toggle('node-selected', g.dataset.id === id));
  showNodeDetail(id);
  switchTab('inspect');
}
function onNodeHover(id) {
  hoveredNode = id; highlightConnected(id);
  const g = document.querySelector('.node-group[data-id="' + id + '"] .node-shape');
  if (g) g.style.filter = 'url(#' + g.dataset.glow + ')';
}
function onNodeLeave() {
  hoveredNode = null; clearHighlights();
  document.querySelectorAll('.node-shape').forEach(n => n.style.filter = '');
}
function highlightConnected(nodeId) {
  const connectedNodes = new Set([nodeId]);
  data.edges.forEach(e => { if (e.from === nodeId || e.to === nodeId) { connectedNodes.add(e.from); connectedNodes.add(e.to); } });
  data.nodes.filter(n => n.type === 'gate').forEach(g => {
    if (g.after === nodeId) connectedNodes.add(g.id);
    if (g.id === nodeId && g.after) connectedNodes.add(g.after);
  });
  document.querySelectorAll('.node-group').forEach(g => {
    const id = g.dataset.id;
    g.classList.toggle('dimmed', !connectedNodes.has(id));
    g.classList.toggle('highlighted', connectedNodes.has(id));
  });
  document.querySelectorAll('.edge-group').forEach(g => {
    const from = g.dataset.from, to = g.dataset.to;
    const isConn = from === nodeId || to === nodeId;
    g.classList.toggle('dimmed', !isConn);
    g.classList.toggle('highlighted', isConn);
  });
}
function clearHighlights() {
  document.querySelectorAll('.node-group').forEach(g => g.classList.remove('dimmed', 'highlighted'));
  document.querySelectorAll('.edge-group').forEach(g => g.classList.remove('dimmed', 'highlighted'));
}

// === Pan & Zoom ===
const graphContainer = document.getElementById('graph-container');
graphContainer.addEventListener('mousedown', e => {
  if (e.target.closest('.node-group') || e.target.closest('.zoom-btn') || e.target.closest('.hook-badge')) return;
  isPanning = true;
  panStart = { x: e.clientX - transform.x, y: e.clientY - transform.y };
  graphContainer.classList.add('dragging');
});
window.addEventListener('mousemove', e => {
  if (!isPanning) return;
  transform.x = e.clientX - panStart.x; transform.y = e.clientY - panStart.y;
  applyTransform();
});
window.addEventListener('mouseup', () => { isPanning = false; graphContainer.classList.remove('dragging'); });
graphContainer.addEventListener('wheel', e => {
  e.preventDefault();
  const delta = e.deltaY > 0 ? 0.9 : 1.1;
  const r = graphContainer.getBoundingClientRect();
  const mx = e.clientX - r.left, my = e.clientY - r.top;
  const newScale = Math.max(0.15, Math.min(3, transform.scale * delta));
  const ratio = newScale / transform.scale;
  transform.x = mx - ratio * (mx - transform.x);
  transform.y = my - ratio * (my - transform.y);
  transform.scale = newScale;
  applyTransform();
}, { passive: false });

function applyTransform() {
  const g = document.getElementById('graph-transform');
  if (g) g.setAttribute('transform', 'translate(' + transform.x + ',' + transform.y + ') scale(' + transform.scale + ')');
}
function zoomIn() {
  const r = graphContainer.getBoundingClientRect();
  const cx = r.width / 2, cy = r.height / 2;
  const ns = Math.min(3, transform.scale * 1.25), ratio = ns / transform.scale;
  transform.x = cx - ratio * (cx - transform.x); transform.y = cy - ratio * (cy - transform.y);
  transform.scale = ns; applyTransform();
}
function zoomOut() {
  const r = graphContainer.getBoundingClientRect();
  const cx = r.width / 2, cy = r.height / 2;
  const ns = Math.max(0.15, transform.scale * 0.8), ratio = ns / transform.scale;
  transform.x = cx - ratio * (cx - transform.x); transform.y = cy - ratio * (cy - transform.y);
  transform.scale = ns; applyTransform();
}
function zoomFit() {
  const r = graphContainer.getBoundingClientRect();
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  Object.values(nodePositions).forEach(p => {
    minX = Math.min(minX, p.x - p.w / 2); minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x + p.w / 2); maxY = Math.max(maxY, p.y + p.h);
  });
  if (minX === Infinity) return;
  const gw = maxX - minX, gh = maxY - minY, pad = 80;
  const sx = (r.width - pad * 2) / gw, sy = (r.height - pad * 2) / gh;
  const ns = Math.min(sx, sy, 1.2);
  transform.scale = ns;
  transform.x = (r.width - gw * ns) / 2 - minX * ns;
  transform.y = (r.height - gh * ns) / 2 - minY * ns;
  applyTransform();
}

// === Toggle Data Flow ===
function toggleDataFlow() {
  dataFlowEnabled = !dataFlowEnabled;
  document.getElementById('dataflow-btn').classList.toggle('active', dataFlowEnabled);
  renderGraph();
}

// === Tab switching ===
document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => switchTab(tab.dataset.tab));
});
function switchTab(tabName) {
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tabName));
  const panel = document.getElementById('side-panel');
  if (panel.classList.contains('collapsed')) panel.classList.remove('collapsed');
  switch (tabName) {
    case 'inspect': showInspectPanel(); break;
    case 'memory': showMemoryPanel(); break;
    case 'runs': showRunsPanel(); break;
    case 'depth': showDepthPanel(); break;
    case 'batch': showBatchPanel(); break;
    case 'envs': showEnvsPanel(); break;
    case 'triggers': showTriggersPanel(); break;
    case 'hooks': showHooksPanel(); break;
    case 'mcp': showMcpPanel(); break;
    case 'skills': showSkillsPanel(); break;
    case 'metering': showMeteringPanel(); break;
    case 'settings': showSettingsPanel(); break;
  }
}

// === Panel renderers ===
function showInspectPanel() {
  if (selectedNode) showNodeDetail(selectedNode);
  else setTabContent('<div style="color:var(--t2);font-size:13px;text-align:center;margin-top:40px">Click a node to inspect</div>');
}

function showNodeDetail(id) {
  const node = data.nodes.find(n => n.id === id);
  if (!node) return;
  const colors = node.type === 'agent' ? modelColor(node.model) : typeColor(node.type);
  let h = '';
  h += renderMiniGraph(id);
  h += '<div class="node-detail-header"><div class="node-icon ' + node.type + '" style="background:' + colors.bg + ';border-color:' + colors.br + '">' + typeIcon(node.type) + '</div>';
  h += '<div><div class="node-detail-name">' + esc(node.label) + '</div>';
  h += '<span class="node-detail-type" style="background:' + colors.bg + ';color:' + colors.main + ';border:1px solid ' + colors.br + '">' + node.type + '</span>';
  if (node.hooks && node.hooks.length > 0) h += '<span style="color:#22d3ee;font-size:11px;margin-left:6px">\\u26A1 ' + node.hooks.length + ' hook' + (node.hooks.length > 1 ? 's' : '') + '</span>';
  h += '</div></div>';
  if (node.role || node.description) h += '<div class="node-detail-role">' + esc(node.role || node.description) + '</div>';
  h += '<div class="panel-section">';
  if (node.model) h += dr('Model', node.model);
  if (node.phase != null) h += dr('Phase', node.phase);
  if (node.permissions) h += dr('Perms', node.permissions);
  if (node.prompt) h += dr('Prompt', node.prompt);
  if (node.isolation) h += dr('Isolation', node.isolation);
  if (node.retry) h += dr('Retry', node.retry);
  if (node.behavior) h += dr('Behavior', node.behavior);
  if (node.invocation) h += dr('Invocation', node.invocation);
  if (node.skip) h += dr('Skip', node.skip);
  if (node.kind) h += dr('Kind', node.kind);
  if (node.source) h += dr('Source', node.source);
  if (node.generates) h += dr('Generates', node.generates);
  if (node.run) h += dr('Run', node.run);
  if (node.onFail) h += dr('On Fail', node.onFail);
  h += '</div>';

  if (node.scale) {
    const sc = node.scale;
    h += '<div class="panel-section"><div class="panel-title" style="color:var(--cyan)">Scale</div>';
    h += dr('Mode', sc.mode);
    if (sc.by) h += dr('By', sc.by);
    h += dr('Min', sc.min); h += dr('Max', sc.max);
    if (sc.batchSize != null) h += dr('Batch Size', sc.batchSize);
    h += '</div>';
  }

  if (node.tools && node.tools.length > 0) {
    const core = node.tools.filter(t => !t.startsWith('mcp.'));
    const mcp = node.tools.filter(t => t.startsWith('mcp.'));
    h += '<div class="panel-section"><div class="panel-title">Tools</div>';
    if (core.length > 0) { h += '<div class="tools-group-title">Core</div>'; h += core.map(t => '<span class="tool-chip core">' + esc(t) + '</span>').join(''); }
    if (mcp.length > 0) { h += '<div class="tools-group-title">MCP</div>'; h += mcp.map(t => '<span class="tool-chip mcp">' + esc(t.replace('mcp.', '')) + '</span>').join(''); }
    h += '</div>';
  }
  if (node.disallowedTools && node.disallowedTools.length > 0) {
    h += '<div class="panel-section"><div class="panel-title">Disallowed Tools</div>';
    h += node.disallowedTools.map(t => '<span class="tool-chip" style="border-color:var(--red-br);color:var(--red)">' + esc(t) + '</span>').join('');
    h += '</div>';
  }
  if (node.skills && node.skills.length > 0) {
    h += '<div class="panel-section"><div class="panel-title" style="color:var(--green)">Skills</div>';
    h += node.skills.map(sk => {
      const def = (data.skills || []).find(s => s.id === sk);
      let chip = '<span class="tool-chip skill">' + esc(sk) + '</span>';
      if (def && def.description) chip += '<div style="font-size:10px;color:var(--t3);margin:2px 0 4px 4px">' + esc(def.description) + '</div>';
      return chip;
    }).join('');
    h += '</div>';
  }
  if (node.reads && node.reads.length > 0) {
    h += '<div class="panel-section"><div class="panel-title">Reads</div>';
    h += '<ul class="panel-list">' + node.reads.map(r => '<li><span style="color:' + folderColor(r) + '">\\u25CF</span> ' + esc(r) + '</li>').join('') + '</ul></div>';
  }
  if (node.writes && node.writes.length > 0) {
    h += '<div class="panel-section"><div class="panel-title">Writes</div>';
    h += '<ul class="panel-list">' + node.writes.map(w => '<li><span style="color:' + folderColor(w) + '">\\u25CF</span> ' + esc(w) + '</li>').join('') + '</ul></div>';
  }
  if (node.outputs) {
    h += '<div class="panel-section"><div class="panel-title">Outputs</div>';
    Object.entries(node.outputs).forEach(function(entry) {
      const key = entry[0], vals = entry[1];
      h += '<div style="margin-bottom:4px"><span style="font-size:11px;color:var(--t3);font-family:var(--font-mono)">' + esc(key) + ':</span> ';
      h += vals.map(v => { const cls = v === 'pass' ? 'pass' : v === 'fail' ? 'fail' : 'default'; return '<span class="output-chip ' + cls + '">' + esc(v) + '</span>'; }).join(' ');
      h += '</div>';
    });
    h += '</div>';
  }
  if (node.checks && node.checks.length > 0) {
    h += '<div class="panel-section"><div class="panel-title">Checks</div>';
    h += '<ul class="panel-list">' + node.checks.map(c => '<li>' + esc(c) + '</li>').join('') + '</ul></div>';
  }
  if (node.commands && node.commands.length > 0) {
    h += '<div class="panel-section"><div class="panel-title">Commands</div>';
    h += '<ul class="panel-list">' + node.commands.map(c => '<li>' + esc(c) + '</li>').join('') + '</ul></div>';
  }
  if (node.handles && node.handles.length > 0) {
    h += '<div class="panel-section"><div class="panel-title">Handles</div>';
    h += node.handles.map(x => '<span class="panel-tag">' + esc(x) + '</span>').join(' ');
    h += '</div>';
  }
  if (node.hooks && node.hooks.length > 0) {
    h += '<div class="panel-section"><div class="panel-title" style="color:#22d3ee">\\u26A1 Hooks</div>';
    node.hooks.forEach(hk => {
      const origin = hk.global ? '<span style="font-size:9px;color:var(--t3);margin-left:6px;text-transform:uppercase;letter-spacing:.5px">global</span>' : '';
      h += '<div class="panel-card" style="padding:8px 10px;margin-bottom:6px;border-color:rgba(34,211,238,.15)">';
      h += '<div style="font-size:12px;font-weight:600;color:#22d3ee;font-family:var(--font-heading)">' + esc(hk.name) + origin + '</div>';
      h += '<div style="font-size:11px;color:var(--t2);margin-top:2px"><span class="panel-tag">' + esc(hk.on) + '</span>';
      if (hk.matcher) h += ' <span class="panel-tag">' + esc(hk.matcher) + '</span>';
      h += '</div>';
      if (hk.run) h += '<div style="font-size:11px;font-family:var(--font-mono);color:var(--t3);margin-top:2px">' + esc(hk.run) + '</div>';
      h += '</div>';
    });
    h += '</div>';
  }
  const inEdges = data.edges.filter(e => e.to === id);
  const outEdges = data.edges.filter(e => e.from === id);
  if (inEdges.length > 0 || outEdges.length > 0) {
    h += '<div class="panel-section"><div class="panel-title">Connections</div>';
    if (inEdges.length > 0) {
      h += '<div class="tools-group-title">Incoming</div>';
      inEdges.forEach(e => {
        const fn = data.nodes.find(n => n.id === e.from);
        h += '<div style="font-size:11px;margin:2px 0;color:var(--t2)"><span style="color:var(--t)">' + esc(fn?.label || e.from) + '</span>';
        if (e.condition) h += ' <span style="color:var(--t3);font-family:var(--font-mono);font-size:10px">' + esc(e.condition) + '</span>';
        if (e.maxIterations) h += ' <span style="color:var(--orange);font-size:10px">max ' + e.maxIterations + '</span>';
        h += '</div>';
      });
    }
    if (outEdges.length > 0) {
      h += '<div class="tools-group-title">Outgoing</div>';
      outEdges.forEach(e => {
        const tn = data.nodes.find(n => n.id === e.to);
        h += '<div style="font-size:11px;margin:2px 0;color:var(--t2)">\\u2192 <span style="color:var(--t)">' + esc(tn?.label || e.to) + '</span>';
        if (e.condition) h += ' <span style="color:var(--t3);font-family:var(--font-mono);font-size:10px">' + esc(e.condition) + '</span>';
        if (e.maxIterations) h += ' <span style="color:var(--orange);font-size:10px">max ' + e.maxIterations + '</span>';
        h += '</div>';
      });
    }
    h += '</div>';
  }
  setTabContent(h);
}

function renderMiniGraph(nodeId) {
  const connected = new Set([nodeId]);
  data.edges.forEach(e => { if (e.from === nodeId || e.to === nodeId) { connected.add(e.from); connected.add(e.to); } });
  data.nodes.filter(n => n.type === 'gate').forEach(g => { if (g.after === nodeId) connected.add(g.id); });
  const nodes = data.nodes.filter(n => connected.has(n.id));
  if (nodes.length <= 1) return '';
  const W = 340, H = 100;
  const gap = W / (nodes.length + 1);
  let s = '<div class="mini-graph"><svg width="' + W + '" height="' + H + '" viewBox="0 0 ' + W + ' ' + H + '">';
  const miniPos = {};
  nodes.forEach((n, i) => { miniPos[n.id] = { x: gap * (i + 1), y: n.id === nodeId ? 40 : 55 }; });
  const relevantEdges = data.edges.filter(e => connected.has(e.from) && connected.has(e.to));
  relevantEdges.forEach(e => {
    const fp = miniPos[e.from], tp = miniPos[e.to];
    if (!fp || !tp) return;
    const isFailure = e.condition && e.condition.includes('fail');
    const isLoop = e.maxIterations != null;
    const color = isFailure ? '#f87171' : isLoop ? '#fb923c' : e.condition ? '#5858a0' : 'rgba(255,255,255,.15)';
    const dash = (e.condition || isLoop) ? 'stroke-dasharray="3 2"' : '';
    s += '<line x1="' + fp.x + '" y1="' + fp.y + '" x2="' + tp.x + '" y2="' + tp.y + '" stroke="' + color + '" stroke-width="1" ' + dash + '/>';
  });
  nodes.forEach(n => {
    const p = miniPos[n.id];
    const colors = n.type === 'agent' ? modelColor(n.model) : typeColor(n.type);
    const isCurrent = n.id === nodeId;
    const r = isCurrent ? 14 : 10;
    s += '<circle cx="' + p.x + '" cy="' + p.y + '" r="' + r + '" fill="' + colors.bg + '" stroke="' + colors.main + '" stroke-width="' + (isCurrent ? 2 : 1) + '"/>';
    s += '<text x="' + p.x + '" y="' + (p.y + r + 12) + '" text-anchor="middle" font-family="monospace" font-size="8" fill="' + (isCurrent ? colors.main : '#8888a8') + '" font-weight="' + (isCurrent ? '600' : '400') + '">' + esc(n.label) + '</text>';
  });
  s += '</svg></div>';
  return s;
}

function showMemoryPanel() {
  const mem = data.memory;
  if (!mem || Object.keys(mem).length === 0) { setTabContent(emptyMsg('No memory config')); return; }
  let h = '';
  Object.entries(mem).forEach(function(entry) {
    const key = entry[0], val = entry[1];
    h += '<div class="panel-section"><div class="panel-title">' + esc(key) + '</div>';
    h += '<div class="panel-card"><div class="panel-card-desc" style="font-family:var(--font-mono);font-size:10px;word-break:break-all">' + esc(JSON.stringify(val, null, 2)) + '</div></div>';
    h += '</div>';
  });
  setTabContent(h);
}

function showRunsPanel() {
  setTabContent('<div style="color:var(--t2);font-size:13px;text-align:center;margin-top:40px">No run data embedded.</div>');
}

function showDepthPanel() {
  const depth = data.depth;
  if (!depth || (!depth.factors?.length && !depth.levels?.length)) { setTabContent(emptyMsg('No depth config')); return; }
  let h = '';
  if (depth.factors && depth.factors.length > 0) {
    h += '<div class="panel-section"><div class="panel-title">Factors</div>';
    h += '<ul class="panel-list">' + depth.factors.map(f => '<li>' + esc(f) + '</li>').join('') + '</ul></div>';
  }
  if (depth.levels && depth.levels.length > 0) {
    h += '<div class="panel-section"><div class="panel-title">Levels</div>';
    depth.levels.forEach(level => {
      h += '<div class="panel-card"><div class="panel-card-title">' + level.level + ' - ' + esc(level.label) + '</div>';
      h += '<div class="panel-card-desc">Omit: ' + (level.omit.length > 0 ? level.omit.map(o => '<span class="panel-tag">' + esc(o) + '</span>').join(' ') : '<span style="color:var(--green)">none</span>') + '</div></div>';
    });
    h += '</div>';
  }
  setTabContent(h);
}

function showBatchPanel() {
  const batch = data.batch;
  if (!batch || Object.keys(batch).length === 0) { setTabContent(emptyMsg('No batch config')); return; }
  let h = '<div class="panel-section"><div class="panel-title">Batch Configuration</div>';
  h += '<div class="panel-card"><div class="panel-card-desc" style="font-family:var(--font-mono);font-size:10px">' + esc(JSON.stringify(batch, null, 2)) + '</div></div>';
  h += '</div>';
  setTabContent(h);
}

function showEnvsPanel() {
  const envs = data.environments;
  if (!envs || Object.keys(envs).length === 0) { setTabContent(emptyMsg('No environments')); return; }
  let h = '';
  Object.entries(envs).forEach(function(entry) {
    const name = entry[0], env = entry[1];
    const color = name === 'production' ? 'var(--red)' : 'var(--green)';
    h += '<div class="panel-section"><div class="panel-title" style="color:' + color + '">' + esc(name) + '</div>';
    h += '<div class="panel-card">';
    Object.entries(env).forEach(function(e2) {
      h += '<div style="margin:3px 0;font-size:12px"><span style="color:var(--t3);font-family:var(--font-mono);font-size:11px">' + esc(e2[0]) + ':</span> <span style="color:var(--t)">' + esc(String(e2[1])) + '</span></div>';
    });
    h += '</div></div>';
  });
  setTabContent(h);
}

function showTriggersPanel() {
  const triggers = data.triggers;
  if (!triggers || triggers.length === 0) { setTabContent(emptyMsg('No triggers')); return; }
  let h = '<div class="panel-section"><div class="panel-title">Command Triggers</div>';
  triggers.forEach(t => {
    h += '<div class="panel-card"><div class="panel-card-title" style="font-family:var(--font-mono);color:var(--purple)">' + esc(t.pattern) + '</div>';
    if (t.argument) h += '<div class="panel-card-desc">Argument: <span class="panel-tag">' + esc(t.argument) + '</span></div>';
    h += '</div>';
  });
  h += '</div>';
  setTabContent(h);
}

function showHooksPanel() {
  const hooks = data.hooks;
  if (!hooks || hooks.length === 0) { setTabContent(emptyMsg('No hooks')); return; }
  let h = '<div class="panel-section"><div class="panel-title">\\u26A1 Global Hooks</div>';
  hooks.forEach(hk => {
    h += '<div class="panel-card" style="border-color:rgba(34,211,238,.15)">';
    h += '<div class="panel-card-title" style="color:#22d3ee">' + esc(hk.name) + '</div>';
    h += '<div class="panel-card-desc">';
    h += '<div>Event: <span class="panel-tag">' + esc(hk.on) + '</span></div>';
    if (hk.matcher) h += '<div>Matcher: <span class="panel-tag">' + esc(hk.matcher) + '</span></div>';
    if (hk.run) h += '<div>Run: <span style="font-family:var(--font-mono)">' + esc(hk.run) + '</span></div>';
    if (hk.type) h += '<div>Type: <span class="panel-tag">' + esc(hk.type) + '</span></div>';
    h += '</div></div>';
  });
  h += '</div>';
  setTabContent(h);
}

function showMcpPanel() {
  const servers = data.mcpServers;
  if (!servers || Object.keys(servers).length === 0) { setTabContent(emptyMsg('No MCP servers')); return; }
  let h = '<div class="panel-section"><div class="panel-title">MCP Servers</div>';
  Object.entries(servers).forEach(function(entry) {
    const name = entry[0], cfg = entry[1];
    h += '<div class="panel-card"><div class="panel-card-title" style="display:flex;align-items:center;gap:8px">';
    if (cfg.type) h += '<span class="panel-tag" style="background:var(--purple-bg);color:var(--purple);border-color:var(--purple-br)">' + esc(cfg.type) + '</span>';
    h += esc(name) + '</div>';
    h += '<div class="panel-card-desc" style="font-family:var(--font-mono);font-size:10px;word-break:break-all">';
    if (cfg.command) h += esc(cfg.command) + ' ' + (cfg.args || []).map(a => esc(a)).join(' ');
    if (cfg.url) h += esc(cfg.url);
    h += '</div></div>';
  });
  h += '</div>';
  setTabContent(h);
}

function showSkillsPanel() {
  const skills = data.skills || [];
  const toolDefs = data.toolDefs || [];
  if (skills.length === 0 && toolDefs.length === 0) { setTabContent(emptyMsg('No skills or custom tools')); return; }
  let h = '';
  if (skills.length > 0) {
    h += '<div class="panel-section"><div class="panel-title" style="color:var(--green)">Skills (' + skills.length + ')</div>';
    skills.forEach(sk => {
      h += '<div class="skill-card"><div class="skill-card-name">' + esc(sk.id) + '</div>';
      if (sk.description) h += '<div class="skill-card-desc">' + esc(sk.description) + '</div>';
      h += '<div class="skill-card-meta">';
      if (sk.scripts) sk.scripts.forEach(sc => { h += '<span class="tool-chip script-tool">' + esc(sc) + '</span>'; });
      if (sk.domains) sk.domains.forEach(d => { h += '<span class="tool-chip" style="background:var(--cyan-bg);color:var(--cyan);border-color:var(--cyan-br)">' + esc(d) + '</span>'; });
      if (sk.references) sk.references.forEach(r => { h += '<span class="tool-chip" style="background:var(--blue-bg);color:var(--blue);border-color:var(--blue-br)">' + esc(r) + '</span>'; });
      if (sk.prompt) h += '<span class="tool-chip" style="background:var(--gold-bg);color:var(--gold);border-color:var(--gold-br)">' + esc(sk.prompt) + '</span>';
      h += '</div>';
      const users = data.nodes.filter(n => n.skills && n.skills.includes(sk.id));
      if (users.length > 0) h += '<div class="skill-card-agents">' + users.length + ' agent' + (users.length > 1 ? 's' : '') + ': ' + users.map(u => esc(u.label)).join(', ') + '</div>';
      h += '</div>';
    });
    h += '</div>';
  }
  if (toolDefs.length > 0) {
    h += '<div class="panel-section"><div class="panel-title" style="color:var(--orange)">Custom Tools (' + toolDefs.length + ')</div>';
    toolDefs.forEach(td => {
      h += '<div class="tool-card"><div class="tool-card-name">' + esc(td.id) + '</div>';
      h += '<div class="tool-card-script">' + esc(td.script) + (td.lang ? ' (' + td.lang + ')' : '') + '</div>';
      if (td.description) h += '<div class="tool-card-desc">' + esc(td.description) + '</div>';
      if (td.args && td.args.length > 0) h += '<div style="margin-top:4px">' + td.args.map(a => '<span class="panel-tag">' + esc(a) + '</span>').join(' ') + '</div>';
      h += '</div>';
    });
    h += '</div>';
  }
  setTabContent(h);
}

function showMeteringPanel() {
  const metering = data.metering;
  if (!metering) { setTabContent(emptyMsg('No metering config')); return; }
  let h = '<div class="panel-section"><div class="panel-title" style="color:var(--cyan)">Metering</div>';
  if (metering.track && metering.track.length > 0) {
    h += '<div class="tools-group-title">Track</div>';
    h += metering.track.map(t => '<span class="panel-tag" style="background:var(--cyan-bg);color:var(--cyan);border-color:var(--cyan-br)">' + esc(t) + '</span>').join(' ');
  }
  if (metering.per && metering.per.length > 0) {
    h += '<div class="tools-group-title" style="margin-top:8px">Per</div>';
    h += metering.per.map(p => '<span class="panel-tag">' + esc(p) + '</span>').join(' ');
  }
  if (metering.output) h += dr('Output', metering.output);
  if (metering.format) h += dr('Format', metering.format);
  if (metering.pricing) h += dr('Pricing', metering.pricing);
  h += '</div>';
  setTabContent(h);
}

function showSettingsPanel() {
  const settings = data.settings;
  if (!settings) { setTabContent(emptyMsg('No settings')); return; }
  let h = '';
  ['allow', 'deny', 'ask'].forEach(key => {
    const color = key === 'allow' ? 'var(--green)' : key === 'deny' ? 'var(--red)' : 'var(--gold)';
    const bgVar = key === 'allow' ? 'green' : key === 'deny' ? 'red' : 'gold';
    h += '<div class="panel-section"><div class="panel-title" style="color:' + color + '">' + key.charAt(0).toUpperCase() + key.slice(1) + '</div>';
    if (settings[key] && settings[key].length > 0) {
      h += settings[key].map(a => '<div style="margin:3px 0"><span class="tool-chip" style="background:var(--' + bgVar + '-bg);color:var(--' + bgVar + ');border-color:var(--' + bgVar + '-br)">' + esc(a) + '</span></div>').join('');
    } else {
      h += '<div style="font-size:12px;color:var(--t3)">none</div>';
    }
    h += '</div>';
  });
  setTabContent(h);
}

// === Helpers ===
function dr(label, value) {
  return '<div class="detail-row"><span class="detail-label">' + esc(label) + '</span><span class="detail-value">' + esc(String(value)) + '</span></div>';
}
function setTabContent(html) { document.getElementById('tab-content').innerHTML = html; }
function emptyMsg(text) { return '<div style="color:var(--t2);font-size:13px;text-align:center;margin-top:40px">' + text + '</div>'; }
function esc(str) {
  if (!str) return '';
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function togglePanel() {
  const panel = document.getElementById('side-panel');
  panel.classList.toggle('collapsed');
  const btn = document.getElementById('panel-btn');
  btn.innerHTML = panel.classList.contains('collapsed') ? 'Panel &#9654;' : '&#9664; Panel';
  setTimeout(zoomFit, 250);
}
function toggleOrientation() {
  isHorizontal = !isHorizontal;
  const btn = document.getElementById('orientation-btn');
  btn.innerHTML = isHorizontal ? '&#8597; Vertical' : '&#8596; Horizontal';
  transform = { x: 0, y: 0, scale: 1 };
  renderGraph();
}

// === Load modal ===
function openLoadModal() { document.getElementById('load-modal').classList.add('open'); document.getElementById('json-input').focus(); }
function closeLoadModal() { document.getElementById('load-modal').classList.remove('open'); }
function loadFromInput() {
  const input = document.getElementById('json-input').value.trim();
  try { const parsed = JSON.parse(input); loadData(parsed); closeLoadModal(); }
  catch (e) { alert('Invalid JSON: ' + e.message); }
}

// === Data loading ===
function loadData(json) {
  data = json; selectedNode = null; hoveredNode = null;
  transform = { x: 0, y: 0, scale: 1 };
  const topo = json.topology || {};
  document.getElementById('topo-name').textContent = topo.name || 'Untitled';
  document.getElementById('topo-ver').textContent = topo.version ? 'v' + topo.version : '';
  document.getElementById('topo-desc').textContent = topo.description || '';
  const badgesEl = document.getElementById('pattern-badges');
  badgesEl.innerHTML = (topo.patterns || []).map(p => '<span class="pattern-badge ' + p + '">' + esc(p) + '</span>').join('');
  if (topo.foundations) {
    badgesEl.innerHTML += topo.foundations.map(f => '<span class="pattern-badge" style="background:var(--s2);color:var(--t2);border:1px solid var(--b)">' + esc(f) + '</span>').join('');
  }
  if (topo.advanced) {
    badgesEl.innerHTML += topo.advanced.map(a => '<span class="pattern-badge" style="background:var(--amber-bg);color:var(--amber);border:1px solid var(--amber-br)">' + esc(a) + '</span>').join('');
  }
  renderGraph();
  switchTab('inspect');
}

// === Init ===
window.addEventListener('resize', () => { if (data) zoomFit(); });
loadData(DEFAULT_DATA);
`;

// ---------------------------------------------------------------------------

/**
 * AgenTopology Visualizer.
 *
 * Generates a self-contained HTML file that renders an interactive
 * topology graph from a parsed TopologyAST.  No external dependencies —
 * all CSS and JS are inlined.
 *
 * @module
 */

import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type {
  TopologyAST,
  NodeDef,
  AgentNode,
  GateNode,
  ActionNode,
  HumanNode,
  OrchestratorNode,
} from "../parser/ast.js";
import { validate } from "../parser/validator.js";

// ---------------------------------------------------------------------------
// Load dagre source for inlining into the generated HTML
// ---------------------------------------------------------------------------

const __filename_viz = fileURLToPath(import.meta.url);
const __dirname_viz = dirname(__filename_viz);

function loadDagreSrc(): string {
  const candidates = [
    join(__dirname_viz, "..", "..", "node_modules", "dagre", "dist", "dagre.min.js"),
    join(__dirname_viz, "..", "node_modules", "dagre", "dist", "dagre.min.js"),
    join(__dirname_viz, "node_modules", "dagre", "dist", "dagre.min.js"),
  ];
  for (const p of candidates) {
    try {
      return fs.readFileSync(p, "utf-8");
    } catch {
      // try next
    }
  }
  throw new Error("Could not find dagre.min.js — run: npm install dagre@0.8.5 --save-dev");
}

const DAGRE_SRC = loadDagreSrc();

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
  const issues = validate(ast);
  const issuesJson = JSON.stringify(issues);
  return buildHtml(dataJson, ast.topology.name, issuesJson);
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
      case "human": {
        const h = n as HumanNode;
        if (h.description) base.description = h.description;
        if (h.timeout) base.timeout = h.timeout;
        if (h.onTimeout) base.onTimeout = h.onTimeout;
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

function buildHtml(dataJson: string, title: string, issuesJson: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escHtml(title)} — AgenTopology Visualizer</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Noto+Sans:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>
${CSS}
</style>
</head>
<body>
<script>` + DAGRE_SRC + `</script>
<div id="app">
  <div id="header">
    <div style="display:flex;align-items:center;gap:10px">
      <svg viewBox="0 0 20 24" fill="none" xmlns="http://www.w3.org/2000/svg" style="width:20px;height:24px">
        <line x1="4.5" y1="2" x2="15.5" y2="2" stroke="#878593" stroke-width="1.2"/>
        <line x1="10" y1="2" x2="10" y2="9.5" stroke="#878593" stroke-width="1.2"/>
        <line x1="10" y1="9.5" x2="2.5" y2="22" stroke="#878593" stroke-width="1.2"/>
        <line x1="10" y1="9.5" x2="17.5" y2="22" stroke="#878593" stroke-width="1.2"/>
        <circle cx="4.5" cy="2" r="1.8" stroke="#a78bfa" stroke-width="1.5" fill="none"/>
        <circle cx="15.5" cy="2" r="1.8" stroke="#a78bfa" stroke-width="1.5" fill="none"/>
        <circle cx="10" cy="9.5" r="2" stroke="#a78bfa" stroke-width="1.5" fill="none"/>
        <circle cx="2.5" cy="22" r="1.8" stroke="#fff" stroke-width="1.5" fill="none"/>
        <circle cx="17.5" cy="22" r="1.8" stroke="#fff" stroke-width="1.5" fill="none"/>
      </svg>
      <span style="font-size:13px;color:#878593;font-weight:500;letter-spacing:0.5px">AgenTopology</span>
      <span style="color:#2a2a2a;margin:0 4px">|</span>
    </div>
    <div class="topo-name" id="topo-name"></div>
    <div class="topo-ver" id="topo-ver"></div>
    <div class="topo-desc" id="topo-desc"></div>
    <div class="pattern-badges" id="pattern-badges"></div>
    <input type="text" id="search-input" class="search-input" placeholder="Search nodes..." oninput="onSearchInput(this.value)" />
    <button class="header-btn" id="dataflow-btn" onclick="toggleDataFlow()">Data Flow</button>
    <button class="header-btn" id="orientation-btn" onclick="toggleOrientation()" title="Switch between vertical and horizontal layout">&#8596; Horizontal</button>
    <button class="header-btn" onclick="exportSvg()">Export SVG</button>
    <button class="header-btn" id="issues-btn" onclick="toggleIssuesPanel()" style="display:none">Issues <span id="issues-badge" class="issues-badge">0</span></button>
    <button class="header-btn" onclick="openLoadModal()">Load JSON</button>
    <button class="header-btn" id="panel-btn" onclick="togglePanel()">Panel &#9654;</button>
  </div>
  <div id="main">
    <div id="graph-container">
      <svg id="graph-svg"></svg>
      <div id="zoom-controls">
        <button class="zoom-btn" onclick="zoomIn()" title="Zoom In (+)">+</button>
        <button class="zoom-btn" onclick="zoomOut()" title="Zoom Out (-)">&minus;</button>
        <button class="zoom-btn" onclick="zoomFit()" title="Fit (0)">&#8982;</button>
      </div>
      <div id="legend"></div>
      <div class="svg-tooltip" id="tooltip"></div>
      <div id="trigger-popover" class="trigger-popover" style="display:none"></div>
    </div>
    <div id="issues-panel" class="issues-panel collapsed">
      <div class="issues-panel-header">
        <span class="issues-panel-title">Validation Issues</span>
        <button class="issues-panel-close" onclick="toggleIssuesPanel()">&times;</button>
      </div>
      <div id="issues-list" class="issues-list"></div>
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

<div style="position:fixed;bottom:12px;right:16px;font-size:11px;color:#56545e;font-family:'Noto Sans',sans-serif">
  Generated by <span style="color:#a78bfa">agentopology</span>
</div>

<script>
const DEFAULT_DATA = ${dataJson};
const VALIDATION_ISSUES = ${issuesJson};
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
  --bg:#0A0A0A;--s:#111111;--s2:#161616;--b:#1e1e1e;--b2:#2a2a2a;
  --t:#e4e4ef;--t2:#878593;--t3:#56545e;
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
  --font-mono:'JetBrains Mono',monospace;
  --font-body:'Noto Sans',sans-serif;
  --font-heading:'Noto Sans',sans-serif;
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
.panel-section .panel-title{cursor:pointer;user-select:none;display:flex;align-items:center;gap:6px}
.panel-section .panel-title::before{content:'\\25B8';font-size:10px;color:var(--t3);transition:transform .15s;flex:0 0 auto;width:auto;height:auto;border-radius:0;background:none}
.panel-section.expanded .panel-title::before{transform:rotate(90deg)}
.panel-section .panel-body{display:none;margin-top:6px}
.panel-section.expanded .panel-body{display:block}
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

.search-input{background:var(--s2);border:1px solid var(--b);color:var(--t);padding:5px 10px;border-radius:6px;font-size:11px;font-family:var(--font-mono);width:140px;outline:none;transition:all .15s}
.search-input:focus{border-color:var(--purple);width:180px}
.search-input::placeholder{color:var(--t3)}

.issues-badge{display:inline-block;background:var(--red);color:#fff;font-size:9px;font-weight:700;padding:1px 5px;border-radius:8px;margin-left:4px;min-width:16px;text-align:center}

.issues-panel{position:absolute;top:0;right:0;width:340px;height:100%;background:var(--s);border-left:1px solid var(--b);z-index:15;display:flex;flex-direction:column;transition:transform .2s}
.issues-panel.collapsed{transform:translateX(100%)}
.issues-panel-header{padding:12px 16px;border-bottom:1px solid var(--b);display:flex;align-items:center;justify-content:space-between}
.issues-panel-title{font-family:var(--font-heading);font-size:14px;font-weight:600}
.issues-panel-close{background:none;border:none;color:var(--t2);font-size:18px;cursor:pointer;padding:2px 6px}
.issues-panel-close:hover{color:var(--t)}
.issues-list{flex:1;overflow-y:auto;padding:12px}
.issue-item{background:var(--s2);border:1px solid var(--b);border-radius:8px;padding:10px 12px;margin-bottom:8px}
.issue-item.error{border-left:3px solid var(--red)}
.issue-item.warning{border-left:3px solid var(--gold)}
.issue-rule{font-family:var(--font-mono);font-size:10px;font-weight:600;margin-bottom:4px}
.issue-rule.error{color:var(--red)}
.issue-rule.warning{color:var(--gold)}
.issue-msg{font-size:12px;color:var(--t2);line-height:1.5}
.issue-node{font-family:var(--font-mono);font-size:10px;color:var(--t3);margin-top:4px}

.node-group.search-dimmed{opacity:.15}
.prompt-preview{cursor:pointer}
.prompt-expanded+.prompt-full{display:block!important}

.trigger-popover{position:absolute;z-index:100;background:var(--s2);border:1px solid var(--b2);border-radius:10px;padding:10px 0;min-width:180px;max-width:280px;box-shadow:0 8px 32px rgba(0,0,0,.5);pointer-events:auto;animation:popIn .15s ease-out}
@keyframes popIn{from{opacity:0;transform:scale(.95) translateY(4px)}to{opacity:1;transform:scale(1) translateY(0)}}
.trigger-popover-title{font-family:var(--font-mono);font-size:9px;color:var(--t3);text-transform:uppercase;letter-spacing:1px;padding:0 12px 6px;border-bottom:1px solid var(--b)}
.trigger-popover-item{display:flex;align-items:center;gap:8px;padding:6px 12px;transition:background .1s}
.trigger-popover-item:hover{background:rgba(255,255,255,.04)}
.trigger-popover-cmd{font-family:var(--font-mono);font-size:12px;color:var(--cyan);font-weight:600}
.trigger-popover-pattern{font-family:var(--font-mono);font-size:10px;color:var(--t2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
`;

// ---------------------------------------------------------------------------
// Inline JS  (the full advanced viewer logic)
// ---------------------------------------------------------------------------

const JS = `
// ═══════════════════════════════════════════════════════════════
// SECTION: Data & State
// ═══════════════════════════════════════════════════════════════

// --- Application state ---
let data = null, selectedNode = null, hoveredNode = null;
let transform = { x: 0, y: 0, scale: 1 };
let isPanning = false, panStart = { x: 0, y: 0 };
let nodePositions = {};
let dataFlowEnabled = false;
let isHorizontal = false;
let searchQuery = '';
let issuesPanelOpen = false;

// --- Node size constants ---
const NODE_W = 170, NODE_H = 60, ORCH_W = 180, ORCH_H = 54;
const GATE_W = 130, GATE_H = 48, ACTION_W = 150, ACTION_H = 56;
const TRIGGER_W = 100, TRIGGER_H = 28;

// --- Layout spacing ---
const COL_GAP = 120, ROW_GAP = 140;

// --- Zoom / pan constants ---
const ZOOM_MIN = 0.15, ZOOM_MAX = 3;
const ZOOM_FIT_MAX = 1.2, ZOOM_FIT_PAD = 80;
const PAN_STEP = 50;

// --- Node stagger animation delay (ms per rank) ---
const NODE_STAGGER_MS = 50;

// --- Mini-graph dimensions ---
const MINI_GRAPH_W = 340, MINI_GRAPH_H = 100;

// --- Color palette ---
const COLOR_PURPLE = '#a78bfa';
const COLOR_BLUE   = '#60a5fa';
const COLOR_GREEN  = '#4ade80';
const COLOR_ORANGE = '#fb923c';
const COLOR_GOLD   = '#fbbf24';
const COLOR_GRAY   = '#94a3b8';
const COLOR_RED    = '#f87171';
const COLOR_CYAN   = '#22d3ee';
const COLOR_EDGE_DEFAULT = 'rgba(255,255,255,.15)';  // used in SVG string attrs
const COLOR_EDGE_COND    = '#5858a0';               // used in SVG string attrs

const FOLDER_COLORS = {
  'explore': COLOR_BLUE, 'plan': COLOR_PURPLE, 'build': COLOR_ORANGE,
  'qa': COLOR_GREEN, 'security': COLOR_RED, 'design': '#f472b6',
  'meta-review': COLOR_GOLD, 'ticket': COLOR_GRAY
};

// ═══════════════════════════════════════════════════════════════
// SECTION: Utilities
// ═══════════════════════════════════════════════════════════════

function esc(str) {
  if (!str) return '';
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function dr(label, value) {
  return '<div class="detail-row"><span class="detail-label">' + esc(label) + '</span><span class="detail-value">' + esc(String(value)) + '</span></div>';
}
function setTabContent(html) { document.getElementById('tab-content').innerHTML = html; }
function emptyMsg(text) { return '<div style="color:var(--t2);font-size:13px;text-align:center;margin-top:40px">' + text + '</div>'; }

function folderColor(path) {
  const folder = (path || '').split('/')[0].replace('/*','');
  return FOLDER_COLORS[folder] || COLOR_GRAY;
}
function modelColor(model) {
  if (!model) return { main: COLOR_GRAY, bg: 'rgba(148,163,184,.08)', br: 'rgba(148,163,184,.2)' };
  switch (model.toLowerCase()) {
    case 'opus': return { main: COLOR_PURPLE, bg: 'rgba(167,139,250,.12)', br: 'rgba(167,139,250,.35)' };
    case 'sonnet': return { main: COLOR_BLUE, bg: 'rgba(96,165,250,.12)', br: 'rgba(96,165,250,.35)' };
    case 'haiku': return { main: COLOR_GREEN, bg: 'rgba(74,222,128,.12)', br: 'rgba(74,222,128,.35)' };
    default: return { main: COLOR_GRAY, bg: 'rgba(148,163,184,.08)', br: 'rgba(148,163,184,.2)' };
  }
}
function typeColor(type) {
  switch (type) {
    case 'agent': return { main: COLOR_PURPLE, bg: 'rgba(167,139,250,.10)', br: 'rgba(167,139,250,.25)' };
    case 'action': return { main: COLOR_GRAY, bg: 'rgba(148,163,184,.08)', br: 'rgba(148,163,184,.2)' };
    case 'gate': return { main: COLOR_ORANGE, bg: 'rgba(251,146,60,.10)', br: 'rgba(251,146,60,.25)' };
    case 'orchestrator': return { main: COLOR_GOLD, bg: 'rgba(251,191,36,.10)', br: 'rgba(251,191,36,.25)' };
    default: return { main: COLOR_GRAY, bg: 'rgba(148,163,184,.08)', br: 'rgba(148,163,184,.2)' };
  }
}
function typeIcon(type) {
  switch (type) {
    case 'agent': return '\\u2726'; case 'action': return '\\u25C7';
    case 'gate': return '\\u2B21'; case 'orchestrator': return '\\u2B22';
    default: return '\\u25CB';
  }
}
function nodeSize(node) {
  if (node.type === 'orchestrator') return { w: ORCH_W, h: ORCH_H };
  if (node.type === 'gate') return { w: 120, h: 70 };
  if (node.type === 'action') return { w: ACTION_W, h: ACTION_H };
  return { w: NODE_W, h: NODE_H };
}
function isManualNode(node) { return node.invocation === 'manual'; }

// ═══════════════════════════════════════════════════════════════
// SECTION: Layout Engine
// ═══════════════════════════════════════════════════════════════

function layoutNodes(nodes, edges) {
  var positions = {};
  var nodeMap = {};
  nodes.forEach(function(n) { nodeMap[n.id] = n; });

  var orchestratorNode = nodes.find(function(n) { return n.type === 'orchestrator'; });
  var gateNodes = nodes.filter(function(n) { return n.type === 'gate'; });
  var manualNodes = nodes.filter(function(n) { return isManualNode(n); });
  var triggerNodes = nodes.filter(function(n) { return n.type === 'trigger'; });

  var gateIds = new Set(gateNodes.map(function(g) { return g.id; }));
  var manualIds = new Set(manualNodes.map(function(n) { return n.id; }));
  var triggerIds = new Set(triggerNodes.map(function(n) { return n.id; }));

  // Check if orchestrator has any flow edges
  var orchNode = nodes.find(function(n) { return n.type === 'orchestrator'; });
  var orchInFlow = false;
  if (orchNode) {
    orchInFlow = edges.some(function(e) { return e.from === orchNode.id || e.to === orchNode.id; });
  }

  var dagreNodes = nodes.filter(function(n) {
    if (n.type === 'orchestrator' && !orchInFlow) return false;
    return !gateIds.has(n.id) && !manualIds.has(n.id) && !triggerIds.has(n.id);
  });

  // Create dagre graph
  var g = new dagre.graphlib.Graph();
  g.setGraph({
    rankdir: 'TB',
    nodesep: 100,
    ranksep: 140,
    edgesep: 50,
    marginx: 40,
    marginy: 40,
    ranker: 'network-simplex'
  });
  g.setDefaultEdgeLabel(function() { return {}; });

  // Add nodes to dagre
  dagreNodes.forEach(function(n) {
    var sz = nodeSize(n);
    g.setNode(n.id, { width: sz.w, height: sz.h });
  });

  // Add edges (only between dagre nodes)
  var dagreNodeIds = new Set(dagreNodes.map(function(n) { return n.id; }));
  edges.forEach(function(e) {
    if (dagreNodeIds.has(e.from) && dagreNodeIds.has(e.to)) {
      // dagre does not allow duplicate edges — only add once per (from,to) pair
      if (!g.hasEdge(e.from, e.to)) {
        g.setEdge(e.from, e.to, {
          minlen: 1,
          weight: e.condition ? 1 : 2
        });
      }
    }
  });

  // Run dagre layout
  dagre.layout(g);

  // Extract positions (dagre returns center coords, we store top-left y)
  g.nodes().forEach(function(v) {
    var node = g.node(v);
    if (node) {
      var sz = nodeSize(nodeMap[v]);
      positions[v] = { x: node.x, y: node.y - sz.h / 2, w: sz.w, h: sz.h };
    }
  });

  // Store edge points for smoother edge rendering
  var edgePoints = {};
  g.edges().forEach(function(e) {
    var edge = g.edge(e);
    if (edge && edge.points) {
      edgePoints[e.v + '->' + e.w] = edge.points;
    }
  });
  window.__dagreEdgePoints = edgePoints;

  // Position gates between their after/before nodes (same logic as before)
  gateNodes.forEach(function(gate) {
    if (gate.after && gate.before && gate.after === gate.before && positions[gate.after]) {
      var refPos = positions[gate.after];
      var sz = nodeSize(gate);
      positions[gate.id] = { x: refPos.x, y: refPos.y + refPos.h + ROW_GAP / 2, w: sz.w, h: sz.h };
    } else if (gate.after && gate.before && positions[gate.after] && positions[gate.before]) {
      var afterPos = positions[gate.after], beforePos = positions[gate.before];
      var sz = nodeSize(gate);
      positions[gate.id] = {
        x: (afterPos.x + beforePos.x) / 2,
        y: afterPos.y + afterPos.h + (beforePos.y - afterPos.y - afterPos.h) / 2 - sz.h / 2,
        w: sz.w, h: sz.h
      };
    } else if (gate.after && positions[gate.after]) {
      var afterPos2 = positions[gate.after];
      var sz2 = nodeSize(gate);
      positions[gate.id] = {
        x: afterPos2.x + afterPos2.w / 2 + sz2.w / 2 + 30,
        y: afterPos2.y + afterPos2.h / 2 - sz2.h / 2,
        w: sz2.w, h: sz2.h
      };
    }
  });

  // Position manual nodes in sidebar
  if (manualNodes.length > 0) {
    var maxRightX = 0;
    Object.values(positions).forEach(function(p) { maxRightX = Math.max(maxRightX, p.x + p.w / 2); });
    var sidebarX = maxRightX + 160;
    var sideY = 80;
    manualNodes.forEach(function(n) {
      var sz = nodeSize(n);
      positions[n.id] = { x: sidebarX, y: sideY, w: sz.w, h: sz.h };
      sideY += sz.h + 30;
    });
  }

  // Position orchestrator above the flow when it has no flow edges
  if (orchNode && !orchInFlow) {
    var allPosArr = Object.values(positions);
    if (allPosArr.length > 0) {
      var minY = Infinity, sumX = 0, count = 0;
      allPosArr.forEach(function(p) {
        if (p.y < minY) minY = p.y;
        sumX += p.x; count++;
      });
      var orchSz = nodeSize(orchNode);
      positions[orchNode.id] = { x: sumX / count, y: minY - orchSz.h - 60, w: orchSz.w, h: orchSz.h };
    }
  }

  // Place any remaining disconnected nodes
  var placed = new Set(Object.keys(positions));
  var disconnected = nodes.filter(function(n) { return n.type !== 'orchestrator' && !placed.has(n.id); });
  if (disconnected.length > 0) {
    var maxRX = 0;
    Object.values(positions).forEach(function(p) { maxRX = Math.max(maxRX, p.x + p.w / 2); });
    var dcX = maxRX + 120;
    var dcY = 40;
    disconnected.forEach(function(n) {
      var sz = nodeSize(n);
      positions[n.id] = { x: dcX, y: dcY, w: sz.w, h: sz.h };
      dcY += sz.h + 24;
    });
  }
  return positions;
}

// ═══════════════════════════════════════════════════════════════
// SECTION: Rendering
// ═══════════════════════════════════════════════════════════════

function renderGraph() {
  if (!data) return;
  const svg = document.getElementById('graph-svg');
  const container = document.getElementById('graph-container');
  const rect = container.getBoundingClientRect();

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

  // --- Build parallel-edge lookup ---
  const edgePairCount = {};
  const edgePairIndex = {};
  data.edges.forEach(edge => {
    const pairKey = [edge.from, edge.to].sort().join('::');
    if (!edgePairCount[pairKey]) edgePairCount[pairKey] = 0;
    edgePairIndex[edge.from + '::' + edge.to + '::' + (edge.condition||'') + '::' + (edge.maxIterations||'')] = edgePairCount[pairKey];
    edgePairCount[pairKey]++;
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

    // Parallel edge offset
    const pairKey = [edge.from, edge.to].sort().join('::');
    const pairTotal = edgePairCount[pairKey] || 1;
    const edgeKey = edge.from + '::' + edge.to + '::' + (edge.condition||'') + '::' + (edge.maxIterations||'');
    const pairIdx = edgePairIndex[edgeKey] || 0;
    const perpOffset = pairTotal > 1 ? (pairIdx - (pairTotal - 1) / 2) * 16 : 0;

    const fromY = fromPos.y + fromPos.h, toY = toPos.y;
    const fromX = fromPos.x, toX = toPos.x;

    let pathD;
    const isBackEdge = toPos.y <= fromPos.y + fromPos.h;
    if (isBackEdge && (isLoop || isFailure)) {
      // Back edges: use the far-right curve rendering
      const allPos = Object.values(nodePositions);
      let maxRight = 0;
      allPos.forEach(p => { maxRight = Math.max(maxRight, p.x + p.w / 2); });
      const loopX = maxRight + 60 + perpOffset;
      const startY = fromPos.y + fromPos.h / 2, endY = toPos.y + toPos.h / 2;
      const startX = fromPos.x + fromPos.w / 2, endX = toPos.x + toPos.w / 2;
      pathD = 'M' + startX + ',' + startY + ' C' + loopX + ',' + startY + ' ' + loopX + ',' + endY + ' ' + endX + ',' + endY;
    } else {
      // Try dagre edge points first
      var dagreKey = edge.from + '->' + edge.to;
      var pts = window.__dagreEdgePoints && window.__dagreEdgePoints[dagreKey];
      if (pts && pts.length >= 2) {
        // Build smooth path through dagre points
        pathD = 'M' + pts[0].x + ',' + pts[0].y;
        if (pts.length === 2) {
          pathD += ' L' + pts[1].x + ',' + pts[1].y;
        } else {
          for (var pi = 1; pi < pts.length; pi++) {
            if (pi === 1) {
              var midX1 = (pts[0].x + pts[1].x) / 2;
              var midY1 = (pts[0].y + pts[1].y) / 2;
              pathD += ' Q' + pts[0].x + ',' + pts[0].y + ' ' + midX1 + ',' + midY1;
            }
            if (pi < pts.length - 1) {
              var midX2 = (pts[pi].x + pts[pi+1].x) / 2;
              var midY2 = (pts[pi].y + pts[pi+1].y) / 2;
              pathD += ' Q' + pts[pi].x + ',' + pts[pi].y + ' ' + midX2 + ',' + midY2;
            } else {
              pathD += ' L' + pts[pi].x + ',' + pts[pi].y;
            }
          }
        }
      } else {
        // Fallback: cubic bezier (for gate edges, manual edges, etc.)
        const midY = fromY + (toY - fromY) / 2;
        const dx = toX - fromX, dy = toY - fromY;
        const len = Math.sqrt(dx * dx + dy * dy) || 1;
        const nx = -dy / len, ny = dx / len;
        const offX = nx * perpOffset, offY = ny * perpOffset;
        pathD = 'M' + (fromX + offX) + ',' + (fromY + offY) + ' C' + (fromX + offX) + ',' + (midY + offY) + ' ' + (toX + offX) + ',' + (midY + offY) + ' ' + (toX + offX) + ',' + (toY + offY);
      }
    }

    // Back-edges with maxIterations get dashed stroke
    const backEdgeDash = isLoop ? ' stroke-dasharray="6 4"' : '';

    s += '<g class="edge-group" data-from="' + edge.from + '" data-to="' + edge.to + '">';
    s += '<path d="' + pathD + '" class="edge-path ' + edgeClass + '" marker-end="' + markerEnd + '"' + backEdgeDash + '/>';

    if (edge.condition || isLoop) {
      const isBack = toPos.y <= fromPos.y + fromPos.h;
      let labelX, labelY;
      if (isBack && (isLoop || isFailure)) {
        const allPos = Object.values(nodePositions);
        let mr = 0; allPos.forEach(p => { mr = Math.max(mr, p.x + p.w / 2); });
        labelX = mr + 70; labelY = (fromPos.y + toPos.y + toPos.h) / 2;
      } else {
        // Use dagre edge midpoint if available
        var dlk = edge.from + '->' + edge.to;
        var dpts = window.__dagreEdgePoints && window.__dagreEdgePoints[dlk];
        if (dpts && dpts.length >= 2) {
          var midIdx = Math.floor(dpts.length / 2);
          labelX = dpts[midIdx].x + 10; labelY = dpts[midIdx].y;
        } else {
          labelX = (fromX + toX) / 2 + 10; labelY = fromY + (toY - fromY) / 2;
        }
        labelX += 20;
      }
      let label = '';
      if (edge.condition) label = edge.condition.replace('orchestrator.', '').replace('qa.', '').replace(' == ', '=');
      if (isLoop) label += (label ? ' ' : '') + 'max ' + edge.maxIterations;
      if (label) {
        if (!edgeLabelCount[edge.from]) edgeLabelCount[edge.from] = 0;
        const labelIdx = edgeLabelCount[edge.from]++;
        const offsetY = labelIdx * 24;
        const finalY = labelY + offsetY;

        // Collision avoidance: push label right if it overlaps any node
        const labelHalfW = (label.length * 5.5 + 16) / 2;
        Object.values(nodePositions).forEach(function(np) {
          var nLeft = np.x - np.w / 2 - 8, nRight = np.x + np.w / 2 + 8;
          var nTop = np.y - 8, nBot = np.y + np.h + 8;
          if (labelX + labelHalfW > nLeft && labelX - labelHalfW < nRight && finalY > nTop && finalY < nBot) {
            labelX = nRight + labelHalfW + 12;
          }
        });
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

  // --- Trigger badge (compact, not inline) ---
  // Triggers are shown as a small badge on the entry node, with a popover on click.
  // This avoids pills stacking on top of nodes in the graph.
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
    // Group triggers by entry node
    const triggersByEntry = {};
    data.triggers.forEach(trigger => {
      const entryId = triggerEntryMap[trigger.name];
      if (!entryId) return;
      if (!triggersByEntry[entryId]) triggersByEntry[entryId] = [];
      triggersByEntry[entryId].push(trigger);
    });
    // Render a small "slash" badge on each entry node — clicking shows popover
    Object.keys(triggersByEntry).forEach(entryId => {
      const triggers = triggersByEntry[entryId];
      const entryPos = nodePositions[entryId];
      if (!entryPos) return;
      const bx = entryPos.x - entryPos.w / 2 + 8;
      const by = entryPos.y - 2;
      s += '<g class="trigger-badge" style="cursor:pointer" onclick="toggleTriggerPopover(\\'' + esc(entryId) + '\\')">';
      s += '<circle cx="' + bx + '" cy="' + by + '" r="9" fill="rgba(34,211,238,.12)" stroke="rgba(34,211,238,.4)" stroke-width="0.8"/>';
      s += '<text x="' + bx + '" y="' + (by + 1) + '" text-anchor="middle" dominant-baseline="central" font-family="monospace" font-size="9" fill="#22d3ee" font-weight="700">/' + (triggers.length > 1 ? triggers.length : '') + '</text>';
      s += '</g>';
    });
    // Store trigger data for popover rendering
    window.__triggersByEntry = triggersByEntry;
    window.__triggerNodePositions = nodePositions;
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
    const staggerDelay = (nodeRanks[node.id] || 0) * NODE_STAGGER_MS;

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
      // Diamond shape (rotated square)
      const diamond = cx + ',' + (cy - hh) + ' ' + (cx + hw) + ',' + cy + ' ' + cx + ',' + (cy + hh) + ' ' + (cx - hw) + ',' + cy;
      const gateDash = node.behavior === 'advisory' ? 'stroke-dasharray="4 3"' : '';
      s += '<polygon class="node-shape" points="' + diamond + '" fill="' + colors.bg + '" stroke="' + colors.main + '" stroke-width="' + (isSelected ? 2.5 : 1) + '" ' + gateDash + ' data-glow="' + glowFilter + '"/>';
    } else if (node.type === 'action') {
      const cx = pos.x, cy = y + pos.h / 2;
      const hw = pos.w / 2, hh = pos.h / 2;
      const d = 'M' + cx + ',' + (cy - hh) + ' Q' + (cx + hw * 0.6) + ',' + (cy - hh * 0.4) + ' ' + (cx + hw) + ',' + cy + ' Q' + (cx + hw * 0.6) + ',' + (cy + hh * 0.4) + ' ' + cx + ',' + (cy + hh) + ' Q' + (cx - hw * 0.6) + ',' + (cy + hh * 0.4) + ' ' + (cx - hw) + ',' + cy + ' Q' + (cx - hw * 0.6) + ',' + (cy - hh * 0.4) + ' ' + cx + ',' + (cy - hh) + ' Z';
      s += '<path class="node-shape" d="' + d + '" fill="' + colors.bg + '" stroke="' + colors.main + '" stroke-width="' + (isSelected ? 2.5 : 1) + '" data-glow="' + glowFilter + '"/>';
    } else {
      s += '<rect class="node-shape" x="' + x + '" y="' + y + '" width="' + pos.w + '" height="' + pos.h + '" rx="12" fill="' + colors.bg + '" stroke="' + colors.main + '" stroke-width="' + (isSelected ? 2.5 : 1) + '" ' + strokeDash + ' ' + dimOpacity + ' data-glow="' + glowFilter + '"/>';
    }

    const labelY = y + pos.h / 2 - (node.type === 'agent' && node.phase != null ? 4 : 0);
    const fullLabel = node.label || '';
    const truncLabel = fullLabel.length > 20 ? fullLabel.substring(0, 20) + '\\u2026' : fullLabel;
    const titleAttr = fullLabel.length > 20 ? ' data-full-label="' + esc(fullLabel) + '"' : '';
    s += '<text class="node-label" x="' + pos.x + '" y="' + labelY + '" fill="' + colors.main + '" ' + dimOpacity + titleAttr + '><title>' + esc(fullLabel) + '</title>' + esc(truncLabel) + '</text>';

    if (node.type === 'agent' && node.phase != null) {
      s += '<text class="node-sublabel" x="' + pos.x + '" y="' + (labelY + 14) + '">Phase ' + node.phase + '</text>';
    } else if (node.type === 'action' && node.kind) {
      s += '<text class="node-sublabel" x="' + pos.x + '" y="' + (labelY + 13) + '">' + esc(node.kind) + '</text>';
    } else if (node.type === 'gate') {
      s += '<text class="node-sublabel" x="' + pos.x + '" y="' + (labelY + 11) + '">gate</text>';
    }

    const badgeY = y - 2;
    const nodeBadges = [];
    if (node.hooks && node.hooks.length > 0) nodeBadges.push({ icon: '\\u26A1', fill: '#22d3ee', bg: 'rgba(34,211,238,.15)', stroke: 'rgba(34,211,238,.35)', tip: node.hooks.map(function(h){return h.name}).join('\\\\n'), font: 'font-size="9"' });
    if (node.skills && node.skills.length > 0) nodeBadges.push({ icon: 'S', fill: '#4ade80', bg: 'rgba(74,222,128,.15)', stroke: 'rgba(74,222,128,.35)', tip: node.skills.join('\\\\n'), font: 'font-weight="700" font-family="monospace" font-size="8"' });
    if (node.behavior === 'advisory') nodeBadges.push({ icon: 'A', fill: '#fbbf24', bg: 'rgba(251,191,36,.15)', stroke: 'rgba(251,191,36,.35)', tip: 'Advisory', font: 'font-weight="700" font-family="monospace" font-size="7"' });
    if (isManual) nodeBadges.push({ icon: 'M', fill: '#94a3b8', bg: 'rgba(148,163,184,.12)', stroke: 'rgba(148,163,184,.25)', tip: 'Manual invocation', font: 'font-weight="700" font-family="monospace" font-size="7"' });

    // Lay out badges horizontally from right edge, each spaced 18px apart
    var badgeSpacing = 18;
    var badgeStartX = x + pos.w - 8;
    nodeBadges.forEach(function(nb, idx) {
      var bx = badgeStartX - idx * badgeSpacing;
      s += '<g class="hook-badge" onmouseenter="showTooltip(event, \\'' + nb.tip + '\\')" onmouseleave="hideTooltip()" style="cursor:pointer">';
      s += '<circle cx="' + bx + '" cy="' + badgeY + '" r="7" fill="' + nb.bg + '" stroke="' + nb.stroke + '" stroke-width="0.5"/>';
      s += '<text x="' + bx + '" y="' + (badgeY + 1) + '" text-anchor="middle" dominant-baseline="central" ' + nb.font + ' fill="' + nb.fill + '">' + nb.icon + '</text>';
      s += '</g>';
    });

    // Track how far left the node badges extend for scale pill placement
    var badgesRightEdge = badgeStartX + 8;
    var badgesLeftEdge = nodeBadges.length > 0 ? (badgeStartX - (nodeBadges.length - 1) * badgeSpacing - 8) : badgesRightEdge;

    if (node.scale) {
      const sc = node.scale;
      let scaleLabel;
      if (sc.mode === 'fixed') scaleLabel = '\\u00D7' + sc.min;
      else if (sc.mode === 'config') scaleLabel = '\\u00D7?';
      else scaleLabel = '\\u00D7' + sc.min + '\\u2013' + sc.max;
      const scW = scaleLabel.length * 5.5 + 10;
      // Place scale pill to the left of all node badges with 6px gap
      const scX = badgesLeftEdge - 6 - scW;
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

// --- Data Flow Overlay ---
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

// --- Legend ---
function renderLegend() {
  const el = document.getElementById('legend');
  let h = '';
  h += '<div class="legend-section-title">Nodes</div>';
  h += '<div class="legend-row"><div class="legend-swatch" style="background:rgba(167,139,250,.12);border:1px solid rgba(167,139,250,.25);border-radius:3px"></div><span class="legend-label">Agent (Opus)</span></div>';
  h += '<div class="legend-row"><div class="legend-swatch" style="background:rgba(96,165,250,.12);border:1px solid rgba(96,165,250,.25);border-radius:3px"></div><span class="legend-label">Agent (Sonnet)</span></div>';
  h += '<div class="legend-row"><div class="legend-swatch" style="background:rgba(74,222,128,.12);border:1px solid rgba(74,222,128,.25);border-radius:3px"></div><span class="legend-label">Agent (Haiku)</span></div>';
  h += '<div class="legend-row"><div class="legend-swatch" style="background:rgba(148,163,184,.08);border:1px solid rgba(148,163,184,.2);border-radius:3px"></div><span class="legend-label">Action</span></div>';
  h += '<div class="legend-row"><div class="legend-swatch" style="background:rgba(251,146,60,.10);border:1px solid rgba(251,146,60,.25);clip-path:polygon(50% 0%,100% 50%,50% 100%,0% 50%);border-radius:0"></div><span class="legend-label">Gate</span></div>';
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

// --- Tooltip ---
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

// --- Trigger Popover ---
let _activePopoverEntry = null;
function toggleTriggerPopover(entryId) {
  hideTooltip();
  const pop = document.getElementById('trigger-popover');
  if (_activePopoverEntry === entryId) {
    pop.style.display = 'none';
    _activePopoverEntry = null;
    return;
  }
  _activePopoverEntry = entryId;
  const triggers = window.__triggersByEntry && window.__triggersByEntry[entryId];
  if (!triggers || !triggers.length) { pop.style.display = 'none'; return; }
  const pos = window.__triggerNodePositions && window.__triggerNodePositions[entryId];
  if (!pos) { pop.style.display = 'none'; return; }

  let h = '<div class="trigger-popover-title">Triggers</div>';
  triggers.forEach(t => {
    h += '<div class="trigger-popover-item">';
    h += '<span class="trigger-popover-cmd">/' + esc(t.name) + '</span>';
    if (t.pattern && t.pattern !== '/' + t.name) {
      h += '<span class="trigger-popover-pattern">' + esc(t.pattern) + '</span>';
    }
    h += '</div>';
  });
  pop.innerHTML = h;
  pop.style.display = 'block';

  // Position relative to graph-container using SVG coordinates -> screen coordinates
  const svg = document.getElementById('graph-svg');
  const container = document.getElementById('graph-container');
  const cRect = container.getBoundingClientRect();
  const badgeX = pos.x - pos.w / 2 + 8;
  const badgeY = pos.y - 2;
  // Convert SVG coords to screen coords using current transform
  const screenX = badgeX * transform.scale + transform.x;
  const screenY = badgeY * transform.scale + transform.y;
  pop.style.left = (screenX + 16) + 'px';
  pop.style.top = (screenY - 10) + 'px';

  // Ensure popover stays within container bounds
  requestAnimationFrame(() => {
    const pRect = pop.getBoundingClientRect();
    if (pRect.right > cRect.right - 10) {
      pop.style.left = (screenX - pRect.width - 10) + 'px';
    }
    if (pRect.bottom > cRect.bottom - 10) {
      pop.style.top = (screenY - pRect.height + 10) + 'px';
    }
  });
}

// Close popover on click outside
document.addEventListener('click', function(e) {
  if (_activePopoverEntry && !e.target.closest('.trigger-badge') && !e.target.closest('#trigger-popover')) {
    document.getElementById('trigger-popover').style.display = 'none';
    _activePopoverEntry = null;
  }
});

// ═══════════════════════════════════════════════════════════════
// SECTION: Interaction
// ═══════════════════════════════════════════════════════════════

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

// --- Pan & Zoom ---
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
  const newScale = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, transform.scale * delta));
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
  const ns = Math.min(ZOOM_MAX, transform.scale * 1.25), ratio = ns / transform.scale;
  transform.x = cx - ratio * (cx - transform.x); transform.y = cy - ratio * (cy - transform.y);
  transform.scale = ns; applyTransform();
}
function zoomOut() {
  const r = graphContainer.getBoundingClientRect();
  const cx = r.width / 2, cy = r.height / 2;
  const ns = Math.max(ZOOM_MIN, transform.scale * 0.8), ratio = ns / transform.scale;
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
  const gw = maxX - minX, gh = maxY - minY, pad = ZOOM_FIT_PAD;
  const sx = (r.width - pad * 2) / gw, sy = (r.height - pad * 2) / gh;
  const ns = Math.min(sx, sy, ZOOM_FIT_MAX);
  transform.scale = ns;
  transform.x = (r.width - gw * ns) / 2 - minX * ns;
  transform.y = (r.height - gh * ns) / 2 - minY * ns;
  applyTransform();
}

// ═══════════════════════════════════════════════════════════════
// SECTION: UI Controls
// ═══════════════════════════════════════════════════════════════

// --- Toggle Data Flow ---
function toggleDataFlow() {
  dataFlowEnabled = !dataFlowEnabled;
  document.getElementById('dataflow-btn').classList.toggle('active', dataFlowEnabled);
  renderGraph();
}

// --- Tab switching ---
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

// --- Panel renderers ---
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
  h += '<div class="node-detail-header"><div class="node-icon ' + esc(node.type) + '" style="background:' + colors.bg + ';border-color:' + colors.br + '">' + typeIcon(node.type) + '</div>';
  h += '<div><div class="node-detail-name">' + esc(node.label) + '</div>';
  h += '<span class="node-detail-type" style="background:' + colors.bg + ';color:' + colors.main + ';border:1px solid ' + colors.br + '">' + esc(node.type) + '</span>';
  if (node.hooks && node.hooks.length > 0) h += '<span style="color:#22d3ee;font-size:11px;margin-left:6px">\\u26A1 ' + node.hooks.length + ' hook' + (node.hooks.length > 1 ? 's' : '') + '</span>';
  h += '</div></div>';
  if (node.role || node.description) h += '<div class="node-detail-role">' + esc(node.role || node.description) + '</div>';
  h += '<div class="panel-section expanded">';
  if (node.model) h += dr('Model', node.model);
  if (node.phase != null) h += dr('Phase', node.phase);
  if (node.permissions) h += dr('Perms', node.permissions);
  if (node.prompt) {
    var truncated = node.prompt.length > 80 ? node.prompt.substring(0, 80) + '...' : node.prompt;
    h += '<div class="detail-row"><span class="detail-label">Prompt</span><span class="detail-value prompt-preview" onclick="this.classList.toggle(\\\'prompt-expanded\\\')">' + esc(truncated) + '</span></div>';
    if (node.prompt.length > 80) {
      h += '<div class="prompt-full" style="display:none;font-size:11px;color:var(--t2);font-family:var(--font-mono);padding:6px 8px;background:rgba(255,255,255,.03);border-radius:6px;margin:4px 0 8px;white-space:pre-wrap;max-height:200px;overflow-y:auto">' + esc(node.prompt) + '</div>';
    }
  }
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
    h += '<div class="panel-section"><div class="panel-title" style="color:var(--cyan)" onclick="this.parentElement.classList.toggle(\\\'expanded\\\')">Scale</div><div class="panel-body">';
    h += dr('Mode', sc.mode);
    if (sc.by) h += dr('By', sc.by);
    h += dr('Min', sc.min); h += dr('Max', sc.max);
    if (sc.batchSize != null) h += dr('Batch Size', sc.batchSize);
    h += '</div></div>';
  }

  if (node.tools && node.tools.length > 0) {
    const core = node.tools.filter(t => !t.startsWith('mcp.'));
    const mcp = node.tools.filter(t => t.startsWith('mcp.'));
    h += '<div class="panel-section expanded"><div class="panel-title" onclick="this.parentElement.classList.toggle(\\\'expanded\\\')">Tools</div><div class="panel-body">';
    if (core.length > 0) { h += '<div class="tools-group-title">Core</div>'; h += core.map(t => '<span class="tool-chip core">' + esc(t) + '</span>').join(''); }
    if (mcp.length > 0) { h += '<div class="tools-group-title">MCP</div>'; h += mcp.map(t => '<span class="tool-chip mcp">' + esc(t.replace('mcp.', '')) + '</span>').join(''); }
    h += '</div></div>';
  }
  if (node.disallowedTools && node.disallowedTools.length > 0) {
    h += '<div class="panel-section"><div class="panel-title" onclick="this.parentElement.classList.toggle(\\\'expanded\\\')">Disallowed Tools</div><div class="panel-body">';
    h += node.disallowedTools.map(t => '<span class="tool-chip" style="border-color:var(--red-br);color:var(--red)">' + esc(t) + '</span>').join('');
    h += '</div></div>';
  }
  if (node.skills && node.skills.length > 0) {
    h += '<div class="panel-section"><div class="panel-title" style="color:var(--green)" onclick="this.parentElement.classList.toggle(\\\'expanded\\\')">Skills</div><div class="panel-body">';
    h += node.skills.map(sk => {
      const def = (data.skills || []).find(s => s.id === sk);
      let chip = '<span class="tool-chip skill">' + esc(sk) + '</span>';
      if (def && def.description) chip += '<div style="font-size:10px;color:var(--t3);margin:2px 0 4px 4px">' + esc(def.description) + '</div>';
      return chip;
    }).join('');
    h += '</div></div>';
  }
  if (node.reads && node.reads.length > 0) {
    h += '<div class="panel-section"><div class="panel-title" onclick="this.parentElement.classList.toggle(\\\'expanded\\\')">Reads</div><div class="panel-body">';
    h += '<ul class="panel-list">' + node.reads.map(r => '<li><span style="color:' + folderColor(r) + '">\\u25CF</span> ' + esc(r) + '</li>').join('') + '</ul></div></div>';
  }
  if (node.writes && node.writes.length > 0) {
    h += '<div class="panel-section"><div class="panel-title" onclick="this.parentElement.classList.toggle(\\\'expanded\\\')">Writes</div><div class="panel-body">';
    h += '<ul class="panel-list">' + node.writes.map(w => '<li><span style="color:' + folderColor(w) + '">\\u25CF</span> ' + esc(w) + '</li>').join('') + '</ul></div></div>';
  }
  if (node.outputs) {
    h += '<div class="panel-section"><div class="panel-title" onclick="this.parentElement.classList.toggle(\\\'expanded\\\')">Outputs</div><div class="panel-body">';
    Object.entries(node.outputs).forEach(function(entry) {
      const key = entry[0], vals = entry[1];
      h += '<div style="margin-bottom:4px"><span style="font-size:11px;color:var(--t3);font-family:var(--font-mono)">' + esc(key) + ':</span> ';
      h += vals.map(v => { const cls = v === 'pass' ? 'pass' : v === 'fail' ? 'fail' : 'default'; return '<span class="output-chip ' + cls + '">' + esc(v) + '</span>'; }).join(' ');
      h += '</div>';
    });
    h += '</div></div>';
  }
  if (node.checks && node.checks.length > 0) {
    h += '<div class="panel-section"><div class="panel-title" onclick="this.parentElement.classList.toggle(\\\'expanded\\\')">Checks</div><div class="panel-body">';
    h += '<ul class="panel-list">' + node.checks.map(c => '<li>' + esc(c) + '</li>').join('') + '</ul></div></div>';
  }
  if (node.commands && node.commands.length > 0) {
    h += '<div class="panel-section"><div class="panel-title" onclick="this.parentElement.classList.toggle(\\\'expanded\\\')">Commands</div><div class="panel-body">';
    h += '<ul class="panel-list">' + node.commands.map(c => '<li>' + esc(c) + '</li>').join('') + '</ul></div></div>';
  }
  if (node.handles && node.handles.length > 0) {
    h += '<div class="panel-section"><div class="panel-title" onclick="this.parentElement.classList.toggle(\\\'expanded\\\')">Handles</div><div class="panel-body">';
    h += node.handles.map(x => '<span class="panel-tag">' + esc(x) + '</span>').join(' ');
    h += '</div></div>';
  }
  if (node.hooks && node.hooks.length > 0) {
    h += '<div class="panel-section"><div class="panel-title" style="color:#22d3ee" onclick="this.parentElement.classList.toggle(\\\'expanded\\\')">\\u26A1 Hooks</div><div class="panel-body">';
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
    h += '</div></div>';
  }
  const inEdges = data.edges.filter(e => e.to === id);
  const outEdges = data.edges.filter(e => e.from === id);
  if (inEdges.length > 0 || outEdges.length > 0) {
    h += '<div class="panel-section expanded"><div class="panel-title" onclick="this.parentElement.classList.toggle(\\\'expanded\\\')">Connections</div><div class="panel-body">';
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
    h += '</div></div>';
  }
  setTabContent(h);
}

function renderMiniGraph(nodeId) {
  const connected = new Set([nodeId]);
  data.edges.forEach(e => { if (e.from === nodeId || e.to === nodeId) { connected.add(e.from); connected.add(e.to); } });
  data.nodes.filter(n => n.type === 'gate').forEach(g => { if (g.after === nodeId) connected.add(g.id); });
  const nodes = data.nodes.filter(n => connected.has(n.id));
  if (nodes.length <= 1) return '';
  const W = MINI_GRAPH_W, H = MINI_GRAPH_H;
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

// --- Toggle Panel & Orientation ---
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

// --- Load modal ---
function openLoadModal() { document.getElementById('load-modal').classList.add('open'); document.getElementById('json-input').focus(); }
function closeLoadModal() { document.getElementById('load-modal').classList.remove('open'); }
function loadFromInput() {
  const input = document.getElementById('json-input').value.trim();
  try { const parsed = JSON.parse(input); loadData(parsed); closeLoadModal(); }
  catch (e) { alert('Invalid JSON: ' + e.message); }
}

// --- Data loading ---
function loadData(json) {
  data = json; selectedNode = null; hoveredNode = null;
  transform = { x: 0, y: 0, scale: 1 };
  const topo = json.topology || {};
  document.getElementById('topo-name').textContent = topo.name || 'Untitled';
  document.getElementById('topo-ver').textContent = topo.version ? 'v' + topo.version : '';
  document.getElementById('topo-desc').textContent = topo.description || '';
  const badgesEl = document.getElementById('pattern-badges');
  badgesEl.innerHTML = (topo.patterns || []).map(p => '<span class="pattern-badge ' + esc(p) + '">' + esc(p) + '</span>').join('');
  if (topo.foundations) {
    badgesEl.innerHTML += topo.foundations.map(f => '<span class="pattern-badge" style="background:var(--s2);color:var(--t2);border:1px solid var(--b)">' + esc(f) + '</span>').join('');
  }
  if (topo.advanced) {
    badgesEl.innerHTML += topo.advanced.map(a => '<span class="pattern-badge" style="background:var(--amber-bg);color:var(--amber);border:1px solid var(--amber-br)">' + esc(a) + '</span>').join('');
  }
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
  renderGraph();
  switchTab('inspect');
}

// --- Keyboard shortcuts ---
window.addEventListener('keydown', e => {
  // Skip if focused on an input/textarea
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
  switch (e.key) {
    case '+': case '=': e.preventDefault(); zoomIn(); break;
    case '-': e.preventDefault(); zoomOut(); break;
    case '0': e.preventDefault(); zoomFit(); break;
    case 'ArrowUp': e.preventDefault(); transform.y += PAN_STEP; applyTransform(); break;
    case 'ArrowDown': e.preventDefault(); transform.y -= PAN_STEP; applyTransform(); break;
    case 'ArrowLeft': e.preventDefault(); transform.x += PAN_STEP; applyTransform(); break;
    case 'ArrowRight': e.preventDefault(); transform.x -= PAN_STEP; applyTransform(); break;
  }
});

// --- Export SVG ---
function exportSvg() {
  const svg = document.getElementById('graph-svg');
  if (!svg) return;
  const clone = svg.cloneNode(true);
  // Add inline styles for standalone SVG
  const styleEl = document.createElementNS('http://www.w3.org/2000/svg', 'style');
  styleEl.textContent = 'text{font-family:-apple-system,BlinkMacSystemFont,\\'Segoe UI\\',sans-serif}.node-label{font-weight:600;font-size:12px}.node-sublabel{font-size:8.5px}.edge-path{fill:none;stroke-width:1.5}.edge-path.unconditional{stroke:rgba(255,255,255,.15)}.edge-path.conditional{stroke:#5858a0;stroke-dasharray:6 4}.edge-path.failure{stroke:#f87171;stroke-dasharray:6 4}.edge-path.loop{stroke:#fb923c;stroke-dasharray:4 4}';
  clone.insertBefore(styleEl, clone.firstChild);
  clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  const blob = new Blob([clone.outerHTML], { type: 'image/svg+xml' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = (data && data.topology ? data.topology.name : 'topology') + '.svg';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// --- Search ---
function onSearchInput(query) {
  searchQuery = (query || '').toLowerCase().trim();
  if (!searchQuery) {
    document.querySelectorAll('.node-group').forEach(g => g.classList.remove('search-dimmed'));
    document.querySelectorAll('.edge-group').forEach(g => g.classList.remove('dimmed'));
    return;
  }
  const matchedIds = new Set();
  data.nodes.forEach(n => {
    if ((n.id && n.id.toLowerCase().includes(searchQuery)) ||
        (n.label && n.label.toLowerCase().includes(searchQuery)) ||
        (n.type && n.type.toLowerCase().includes(searchQuery))) {
      matchedIds.add(n.id);
    }
  });
  document.querySelectorAll('.node-group').forEach(g => {
    g.classList.toggle('search-dimmed', !matchedIds.has(g.dataset.id));
  });
  document.querySelectorAll('.edge-group').forEach(g => {
    const isConn = matchedIds.has(g.dataset.from) || matchedIds.has(g.dataset.to);
    g.classList.toggle('dimmed', !isConn);
  });
}

// --- Validation Issues Panel ---
function initIssuesPanel() {
  const issues = typeof VALIDATION_ISSUES !== 'undefined' ? VALIDATION_ISSUES : [];
  if (issues.length === 0) return;
  const btn = document.getElementById('issues-btn');
  if (btn) btn.style.display = '';
  const badge = document.getElementById('issues-badge');
  if (badge) badge.textContent = issues.length;
  const list = document.getElementById('issues-list');
  if (!list) return;
  let h = '';
  issues.forEach(issue => {
    const lvl = issue.level || 'error';
    h += '<div class="issue-item ' + lvl + '">';
    h += '<div class="issue-rule ' + lvl + '">' + esc(issue.rule) + ' (' + lvl + ')</div>';
    h += '<div class="issue-msg">' + esc(issue.message) + '</div>';
    if (issue.node) h += '<div class="issue-node">Node: ' + esc(issue.node) + '</div>';
    h += '</div>';
  });
  list.innerHTML = h;
}
function toggleIssuesPanel() {
  issuesPanelOpen = !issuesPanelOpen;
  const panel = document.getElementById('issues-panel');
  if (panel) panel.classList.toggle('collapsed', !issuesPanelOpen);
}

// ═══════════════════════════════════════════════════════════════
// SECTION: Init
// ═══════════════════════════════════════════════════════════════

window.addEventListener('resize', () => { if (data) zoomFit(); });
loadData(DEFAULT_DATA);
initIssuesPanel();
`;

// ---------------------------------------------------------------------------

/**
 * Brain visualizer — renders a folder of Obsidian-format markdown as an
 * interactive force-directed graph, the way Obsidian's graph view does, but as
 * a single self-contained HTML file with zero dependencies. No 500MB Electron
 * app needed to *see* the brain.
 *
 * The graph is a projection of the files (same model as Obsidian):
 *   - each `.md` file is a NODE
 *   - each `[[wikilink]]` is a directed EDGE
 *   - a `[[link]]` to a file that doesn't exist is a GHOST node
 *   - `#tags` / frontmatter tags are shown as tag nodes (hyperedges)
 *
 * Layout uses the same four forces Obsidian exposes: center pull, node repel,
 * link spring, and link distance.
 */

import * as fs from "node:fs";
import * as path from "node:path";

/** A node in the brain graph. */
export interface BrainNode {
  /** Slug (filename without .md), used as the link target. */
  id: string;
  /** Display title (from first `# heading`, else the slug). */
  title: string;
  /**
   * Existence status — orthogonal to category. "written" = a real .md file,
   * "ghost" = linked but not yet written, "index" = a hub note.
   */
  kind: "written" | "ghost" | "index";
  /**
   * What KIND of thing this is, inferred from tag namespaces (person/org/topic)
   * — NOT the same as existence. A person who has no note yet is category
   * "person", kind "ghost". This is what makes the graph a knowledge graph
   * rather than a bag of links: a person is colored like a person whether or
   * not their note exists.
   */
  category: "person" | "org" | "topic" | "note";
  /** Frontmatter + inline tags on this note. */
  tags: string[];
  /** Number of inbound links (for sizing). */
  inbound: number;
  /** Raw markdown body (written notes only) — inlined so click-to-open works offline. */
  content?: string;
}

/** Map a tag namespace prefix to a node category. */
function categoryFromTags(tags: string[]): BrainNode["category"] {
  for (const t of tags) {
    const ns = t.split("/")[0];
    if (ns === "person" || ns === "people") return "person";
    if (ns === "org" || ns === "client" || ns === "company") return "org";
    if (ns === "topic" || ns === "tag") return "topic";
  }
  return "note";
}

/** A directed edge from one note to another (a `[[wikilink]]`). */
export interface BrainEdge {
  from: string;
  to: string;
}

/** The parsed brain graph. */
export interface BrainGraph {
  nodes: BrainNode[];
  edges: BrainEdge[];
  /** Distinct tags across the vault, with how many notes carry each. */
  tags: { tag: string; count: number }[];
  vaultPath: string;
}

const WIKILINK_RE = /\[\[([^\]]+)\]\]/g;
const INLINE_TAG_RE = /(?:^|\s)#([a-z0-9][a-z0-9_-]*(?:\/[a-z0-9][a-z0-9_-]*)*)/gi;

/** Normalize a wikilink target: strip alias (`|...`), heading (`#...`), block (`^...`). */
function linkTarget(raw: string): string {
  let t = raw.split("|")[0];
  t = t.split("#")[0];
  t = t.split("^")[0];
  return t.trim().replace(/\.md$/i, "");
}

/** Extract `tags:` from simple YAML frontmatter (list or inline array form). */
function frontmatterTags(content: string): string[] {
  const fm = /^---\n([\s\S]*?)\n---/.exec(content);
  if (!fm) return [];
  const body = fm[1];
  const tags: string[] = [];

  // Inline array: `tags: [a, b, c]`
  const inline = /^tags:\s*\[([^\]]*)\]/m.exec(body);
  if (inline) {
    for (const t of inline[1].split(",")) {
      const v = t.trim().replace(/^["']|["']$/g, "");
      if (v) tags.push(v);
    }
    return tags;
  }

  // List form:
  //   tags:
  //     - a
  //     - b
  const listHeader = /^tags:\s*$/m.exec(body);
  if (listHeader) {
    const after = body.slice(listHeader.index + listHeader[0].length);
    for (const line of after.split("\n")) {
      if (line.trim() === "") continue; // skip the blank line right after `tags:`
      const m = /^\s*-\s*(.+)$/.exec(line);
      if (!m) break; // list ends at first non-item, non-blank line
      const v = m[1].trim().replace(/^["']|["']$/g, "");
      if (v) tags.push(v);
    }
  }
  return tags;
}

/** First `# Heading` in the body, else null. */
function firstHeading(content: string): string | null {
  const m = /^#\s+(.+)$/m.exec(content.replace(/^---\n[\s\S]*?\n---\n?/, ""));
  return m ? m[1].trim() : null;
}

/** Recursively collect `.md` files under a directory. */
function walkMarkdown(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkMarkdown(full));
    else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) out.push(full);
  }
  return out;
}

/**
 * Parse a folder of Obsidian-format markdown into a brain graph.
 *
 * @param vaultPath - Directory containing the `.md` notes.
 */
export function parseBrainVault(vaultPath: string): BrainGraph {
  const files = walkMarkdown(vaultPath);
  const realIds = new Set(files.map((f) => path.basename(f, path.extname(f))));

  const nodes = new Map<string, BrainNode>();
  const edges: BrainEdge[] = [];
  const tagCounts = new Map<string, number>();
  // slug -> inferred category, learned from `person/x` / `org/x` / `topic/x` tags.
  const ghostCategory = new Map<string, BrainNode["category"]>();

  for (const file of files) {
    const id = path.basename(file, ".md");
    const content = fs.readFileSync(file, "utf-8");

    const fmTags = frontmatterTags(content);
    const inlineTags: string[] = [];
    let m: RegExpExecArray | null;
    INLINE_TAG_RE.lastIndex = 0;
    while ((m = INLINE_TAG_RE.exec(content)) !== null) inlineTags.push(m[1]);
    const tags = Array.from(new Set([...fmTags, ...inlineTags]));
    for (const t of tags) tagCounts.set(t, (tagCounts.get(t) ?? 0) + 1);

    // Index notes are hubs: filename starting with `_` or tagged brain/index.
    const isIndex = id.startsWith("_") || tags.some((t) => t === "brain/index");

    nodes.set(id, {
      id,
      title: firstHeading(content) ?? id,
      kind: isIndex ? "index" : "written",
      category: categoryFromTags(tags),
      tags,
      inbound: 0,
      content,
    });

    // A tag like `person/amitai-eliram` tells us the SLUG `amitai-eliram` is a
    // person — even if its note doesn't exist yet. Record that so ghosts get the
    // right category (a person stays a person whether or not their note exists).
    for (const t of tags) {
      const [ns, slug] = t.split("/");
      if (!slug) continue;
      const cat =
        ns === "person" || ns === "people" ? "person" :
        ns === "org" || ns === "client" || ns === "company" ? "org" :
        ns === "topic" ? "topic" : null;
      if (cat && !ghostCategory.has(slug)) ghostCategory.set(slug, cat);
    }

    // Extract wikilink edges — dedupe within a note (Obsidian's graph draws one
    // edge per (source, target) pair, however many times the link is repeated).
    const seenTargets = new Set<string>();
    WIKILINK_RE.lastIndex = 0;
    while ((m = WIKILINK_RE.exec(content)) !== null) {
      const target = linkTarget(m[1]);
      if (!target || target === id || seenTargets.has(target)) continue;
      seenTargets.add(target);
      edges.push({ from: id, to: target });
      // Ghost node: linked but no file exists.
      if (!realIds.has(target) && !nodes.has(target)) {
        nodes.set(target, {
          id: target, title: target, kind: "ghost",
          category: "note", tags: [], inbound: 0,
        });
      }
    }
  }

  // Apply inferred categories to ghost nodes (and any node still "note" that we
  // learned about from another note's namespaced tags).
  for (const n of nodes.values()) {
    if (n.category === "note" && ghostCategory.has(n.id)) {
      n.category = ghostCategory.get(n.id)!;
    }
  }

  // Compute inbound counts for sizing.
  for (const e of edges) {
    const n = nodes.get(e.to);
    if (n) n.inbound++;
  }

  const tags = Array.from(tagCounts.entries())
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count);

  return { nodes: Array.from(nodes.values()), edges, tags, vaultPath };
}

/** Options for rendering the brain HTML. */
export interface RenderBrainOptions {
  /**
   * Relative href to the topology visualization for this brain, if known.
   * When set, the brain view shows a "← Topology" link back to it.
   */
  topologyHref?: string;
  /** Display name of the owning topology (shown on the back-link). */
  topologyName?: string;
}

/**
 * Render a brain graph as a self-contained, dependency-free HTML page with an
 * Obsidian-style force-directed graph view, styled to match the AgentTopology
 * visualizer.
 */
export function renderBrainHtml(graph: BrainGraph, opts: RenderBrainOptions = {}): string {
  const vaultName = path.basename(graph.vaultPath.replace(/\/+$/, "")) || "brain";
  const realCount = graph.nodes.filter((n) => n.kind !== "ghost").length;
  const ghostCount = graph.nodes.filter((n) => n.kind === "ghost").length;

  const data = JSON.stringify({
    nodes: graph.nodes,
    edges: graph.edges,
    tags: graph.tags.slice(0, 24),
  });

  const backLink = opts.topologyHref
    ? `<a class="back-link" href="${escapeHtml(opts.topologyHref)}">← ${escapeHtml(opts.topologyName ?? "Topology")}</a>`
    : "";

  return BRAIN_HTML
    .replace(/__VAULT__/g, escapeHtml(vaultName))
    .replace("__NOTES__", String(realCount))
    .replace("__LINKS__", String(graph.edges.length))
    .replace("__GHOSTS__", String(ghostCount))
    .replace("__TAGS__", String(graph.tags.length))
    .replace("__BACKLINK__", backLink)
    .replace("__DATA__", data);
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string)
  );
}

/**
 * The HTML shell. Self-contained: inline CSS + a tiny force-directed canvas
 * renderer using the same four forces Obsidian exposes (center, repel, link
 * spring, link distance). Styled to match the AgentTopology visualizer.
 * Nodes are colored by CATEGORY (person/org/topic/note); ghosts are drawn
 * hollow (same color, dashed, unfilled) — "not written yet" is a status, not
 * a category. Click a node to open its note in the side panel.
 */
const BRAIN_HTML = String.raw`<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>__VAULT__ — Brain Graph</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Noto+Sans:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>
  :root{
    --bg:#0A0A0A;--s:#111111;--s2:#161616;--b:#1e1e1e;--b2:#2a2a2a;
    --t:#e4e4ef;--t2:#878593;--t3:#56545e;
    --person:#60a5fa;--org:#4ade80;--topic:#fbbf24;--note:#a78bfa;--index:#22d3ee;
    --accent:#a78bfa;
    --font-mono:'JetBrains Mono',monospace;--font-body:'Noto Sans',sans-serif;
  }
  *{box-sizing:border-box}
  html,body{margin:0;height:100%;background:var(--bg);color:var(--t);
    font-family:var(--font-body);font-size:13px;line-height:1.5;overflow:hidden}
  #app{display:flex;height:100vh}
  #stage{flex:1;position:relative;overflow:hidden}
  #header{position:fixed;top:0;left:0;right:0;height:46px;z-index:15;display:flex;align-items:center;gap:14px;
    padding:0 18px;background:var(--s);border-bottom:1px solid var(--b)}
  #header .brand{display:flex;align-items:center;gap:8px;font-weight:600;font-size:14px}
  #header .vault{font-family:var(--font-mono);font-size:12px;color:var(--t2);background:var(--s2);
    padding:3px 10px;border-radius:6px;border:1px solid var(--b)}
  #header .spacer{flex:1}
  #header .stats{display:flex;gap:14px;font-family:var(--font-mono);font-size:11px;color:var(--t3)}
  #header .stats b{color:var(--t2);font-weight:500}
  .back-link{font-family:var(--font-mono);font-size:11px;color:var(--accent);text-decoration:none;
    border:1px solid var(--b2);border-radius:6px;padding:4px 10px;transition:.15s}
  .back-link:hover{background:rgba(167,139,250,.1);border-color:var(--accent)}
  #search input{background:var(--s2);border:1px solid var(--b);color:var(--t);border-radius:7px;
    padding:6px 11px;width:180px;font-size:12px;font-family:var(--font-body);outline:none}
  #search input:focus{border-color:var(--accent)}
  #legend{position:fixed;left:14px;bottom:14px;z-index:12;background:var(--s);border:1px solid var(--b);
    border-radius:10px;padding:10px 14px}
  #legend .row{display:flex;align-items:center;gap:7px;font-size:11px;color:var(--t2);padding:2px 0}
  #legend .dot{width:9px;height:9px;border-radius:50%;flex:none}
  #legend .hr{height:1px;background:var(--b);margin:7px 0}
  #legend .hollow{font-size:10px;color:var(--t3)}
  #controls{position:fixed;right:14px;bottom:14px;z-index:12;background:var(--s);border:1px solid var(--b);
    border-radius:10px;padding:10px 14px;display:flex;gap:16px;font-size:10px;font-family:var(--font-mono)}
  #controls label{display:flex;flex-direction:column;gap:4px;color:var(--t3);text-transform:uppercase;letter-spacing:.5px}
  #controls input[type=range]{width:78px;accent-color:var(--accent)}
  #tip{position:fixed;z-index:20;background:var(--s);border:1px solid var(--b2);border-radius:8px;
    padding:7px 11px;font-size:11px;pointer-events:none;opacity:0;transition:opacity .12s;max-width:260px}
  #tip.show{opacity:1}
  #tip .t{color:var(--t);font-weight:600}
  #tip .cat{font-family:var(--font-mono);font-size:9px;text-transform:uppercase;letter-spacing:1px}
  #tip .tags{color:var(--topic);font-size:10px;margin-top:3px;font-family:var(--font-mono)}
  canvas{display:block;cursor:grab}
  #panel{width:0;background:var(--s);border-left:1px solid var(--b);overflow:hidden;transition:width .2s;flex:none}
  #panel.open{width:400px}
  #panel-in{width:400px;height:100vh;padding:54px 22px 22px;overflow-y:auto;position:relative}
  .p-head{display:flex;align-items:center;gap:10px;margin-bottom:6px}
  .p-dot{width:13px;height:13px;border-radius:50%;flex:none}
  .p-title{font-size:17px;font-weight:600}
  .p-cat{font-family:var(--font-mono);font-size:9px;text-transform:uppercase;letter-spacing:1px;padding:2px 7px;border-radius:4px}
  .p-ghost{font-family:var(--font-mono);font-size:11px;color:var(--topic);margin:8px 0 12px}
  .p-tags{display:flex;flex-wrap:wrap;gap:5px;margin:10px 0 16px}
  .p-tag{font-family:var(--font-mono);font-size:10px;color:var(--t2);background:var(--s2);border:1px solid var(--b);border-radius:4px;padding:2px 7px}
  .p-md{font-size:13px;line-height:1.7;color:var(--t)}
  .p-md h1,.p-md h2,.p-md h3{font-size:15px;margin:16px 0 6px}
  .p-md a{color:var(--accent);text-decoration:none;cursor:pointer}
  .p-md a:hover{text-decoration:underline}
  .p-md code{font-family:var(--font-mono);font-size:11px;background:var(--s2);padding:1px 5px;border-radius:3px}
  .p-md blockquote{border-left:2px solid var(--b2);margin:8px 0;padding:2px 0 2px 12px;color:var(--t2)}
  .p-md hr{border:none;border-top:1px solid var(--b);margin:14px 0}
  .p-close{position:absolute;top:54px;right:18px;cursor:pointer;color:var(--t3);font-size:18px}
  .p-close:hover{color:var(--t)}
  .p-links{margin-top:18px;border-top:1px solid var(--b);padding-top:12px}
  .p-links h4{font-family:var(--font-mono);font-size:10px;text-transform:uppercase;letter-spacing:1px;color:var(--t3);margin:0 0 8px}
  .p-links a{display:block;color:var(--accent);text-decoration:none;font-size:12px;padding:2px 0;cursor:pointer}
  .p-links a:hover{text-decoration:underline}
</style></head>
<body>
<div id="header">
  <div class="brand">🧠 <span>Brain</span></div>
  <div class="vault">__VAULT__</div>
  __BACKLINK__
  <div class="spacer"></div>
  <div class="stats">
    <span><b>__NOTES__</b> notes</span><span><b>__LINKS__</b> links</span>
    <span><b>__GHOSTS__</b> ghosts</span><span><b>__TAGS__</b> tags</span>
  </div>
  <div id="search"><input id="q" placeholder="Search…" autocomplete="off"></div>
</div>
<div id="app">
  <div id="stage">
    <canvas id="c"></canvas>
    <div id="legend">
      <div class="row"><span class="dot" style="background:var(--person)"></span>person</div>
      <div class="row"><span class="dot" style="background:var(--org)"></span>org</div>
      <div class="row"><span class="dot" style="background:var(--topic)"></span>topic</div>
      <div class="row"><span class="dot" style="background:var(--note)"></span>note</div>
      <div class="row"><span class="dot" style="background:var(--index)"></span>index / hub</div>
      <div class="hr"></div>
      <div class="row hollow"><span class="dot" style="background:transparent;border:1.5px dashed var(--t3)"></span>hollow = not written yet</div>
    </div>
    <div id="controls">
      <label>Repel<input type="range" id="repel" min="200" max="6000" value="2200"></label>
      <label>Dist<input type="range" id="dist" min="40" max="300" value="120"></label>
      <label>Center<input type="range" id="center" min="0" max="30" value="8"></label>
    </div>
    <div id="tip"></div>
  </div>
  <div id="panel"><div id="panel-in"></div></div>
</div>
<script>
const DATA = __DATA__;
const c = document.getElementById('c'), x = c.getContext('2d');
let W, H, DPR = Math.min(devicePixelRatio||1, 2);
function size(){ const st=document.getElementById('stage').getBoundingClientRect();
  W=st.width; H=st.height; c.width=W*DPR; c.height=H*DPR; c.style.width=W+'px'; c.style.height=H+'px'; x.setTransform(DPR,0,0,DPR,0,0); }
size(); addEventListener('resize', size);

const CAT = { person:'#60a5fa', org:'#4ade80', topic:'#fbbf24', note:'#a78bfa' };
function nodeColor(n){ return n.kind==='index' ? '#22d3ee' : (CAT[n.category]||CAT.note); }

const N = new Map();
for (const n of DATA.nodes){
  N.set(n.id, Object.assign({}, n, { x: W/2+(Math.random()-.5)*Math.min(W,600), y: H/2+(Math.random()-.5)*Math.min(H,600), vx:0, vy:0 }));
}
const E = DATA.edges.filter(e => N.has(e.from) && N.has(e.to));

let cam = { x:0, y:0, z:1 };
let forces = { repel:2200, dist:120, center:0.008 };
document.getElementById('repel').oninput  = e => forces.repel  = +e.target.value;
document.getElementById('dist').oninput   = e => forces.dist   = +e.target.value;
document.getElementById('center').oninput = e => forces.center = +e.target.value / 1000;

let drag=null, hover=null, panning=false, last={x:0,y:0}, query='', selected=null;
function radius(n){ return (n.kind==='index'?7:5) + Math.min(n.inbound*1.4, 10); }

function step(){
  const nodes = [...N.values()];
  for (let i=0;i<nodes.length;i++){ const a=nodes[i];
    for (let j=i+1;j<nodes.length;j++){ const b=nodes[j];
      let dx=a.x-b.x, dy=a.y-b.y, d2=dx*dx+dy*dy||1, d=Math.sqrt(d2);
      const f=forces.repel/d2, fx=dx/d*f, fy=dy/d*f; a.vx+=fx; a.vy+=fy; b.vx-=fx; b.vy-=fy; } }
  for (const e of E){ const a=N.get(e.from), b=N.get(e.to);
    let dx=b.x-a.x, dy=b.y-a.y, d=Math.hypot(dx,dy)||1;
    const f=(d-forces.dist)*0.015, fx=dx/d*f, fy=dy/d*f; a.vx+=fx; a.vy+=fy; b.vx-=fx; b.vy-=fy; }
  for (const n of nodes){ if(n===drag)continue;
    n.vx+=(W/2-n.x)*forces.center; n.vy+=(H/2-n.y)*forces.center; n.x+=(n.vx*=0.82); n.y+=(n.vy*=0.82); }
}
function toScreen(n){ return { x:(n.x-W/2)*cam.z+W/2+cam.x, y:(n.y-H/2)*cam.z+H/2+cam.y }; }
function fromScreen(px,py){ return { x:(px-W/2-cam.x)/cam.z+W/2, y:(py-H/2-cam.y)/cam.z+H/2 }; }

function draw(){
  x.clearRect(0,0,W,H); x.lineWidth=1;
  for (const e of E){ const na=N.get(e.from), nb=N.get(e.to), a=toScreen(na), b=toScreen(nb);
    const hot=selected&&(e.from===selected.id||e.to===selected.id);
    const g=na.kind==='ghost'||nb.kind==='ghost';
    x.strokeStyle = hot?'rgba(167,139,250,.55)':(g?'rgba(135,133,147,.16)':'rgba(135,133,147,.30)');
    x.beginPath(); x.moveTo(a.x,a.y); x.lineTo(b.x,b.y); x.stroke(); }
  for (const n of N.values()){
    const p=toScreen(n), r=radius(n)*cam.z, col=nodeColor(n);
    const match=query&&(n.title.toLowerCase().includes(query)||n.id.toLowerCase().includes(query));
    const active=n===hover||n===selected||match;
    if (n.kind==='ghost'){
      x.beginPath(); x.arc(p.x,p.y,r,0,7); x.fillStyle='rgba(10,10,10,.6)'; x.fill();
      x.lineWidth=1.5; x.setLineDash([3,3]); x.strokeStyle=col; x.globalAlpha=.85; x.stroke(); x.setLineDash([]); x.globalAlpha=1;
    } else { x.beginPath(); x.arc(p.x,p.y,r,0,7); x.fillStyle=col; x.fill(); }
    if (active){ x.lineWidth=2; x.strokeStyle='#fff'; x.beginPath(); x.arc(p.x,p.y,r+1.5,0,7); x.stroke(); }
    if (cam.z>0.6 || active){
      x.fillStyle = active?'#fff':'#878593';
      x.font = (n.kind==='index'?'600 ':'')+(11*Math.min(cam.z,1.3))+'px "Noto Sans",sans-serif';
      x.textAlign='center'; x.fillText(n.title, p.x, p.y+r+12); }
  }
}
(function loop(){ step(); draw(); requestAnimationFrame(loop); })();

const panel=document.getElementById('panel'), panelIn=document.getElementById('panel-in');
function mdToHtml(md){
  md = md.replace(/^---\n[\s\S]*?\n---\n?/, '');
  return md.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/^### (.*)$/gm,'<h3>$1</h3>').replace(/^## (.*)$/gm,'<h2>$1</h2>').replace(/^# (.*)$/gm,'<h1>$1</h1>')
    .replace(/^&gt; (.*)$/gm,'<blockquote>$1</blockquote>').replace(/^---$/gm,'<hr>')
    .replace(/\*\*([^*]+)\*\*/g,'<b>$1</b>').replace(/` + "`([^`]+)`" + String.raw`/g,'<code>$1</code>')
    .replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g,(m,t,a)=>'<a data-link="'+t.trim()+'">'+(a||t).trim()+'</a>')
    .replace(/\n\n/g,'<br><br>').replace(/\n/g,'<br>');
}
function openNode(n){
  selected=n; const col=nodeColor(n);
  const catLabel = n.kind==='index'?'INDEX':(n.category||'note').toUpperCase();
  let h='<div class="p-close" onclick="closePanel()">×</div>';
  h+='<div class="p-head"><span class="p-dot" style="'+(n.kind==='ghost'?'background:transparent;border:1.5px dashed '+col:'background:'+col)+'"></span><span class="p-title">'+n.title+'</span></div>';
  h+='<span class="p-cat" style="color:'+col+';background:'+col+'22">'+catLabel+'</span>';
  if(n.kind==='ghost') h+='<div class="p-ghost">⊘ Not written yet — a [[link]] points here, but no note exists. A gap to fill.</div>';
  if(n.tags&&n.tags.length) h+='<div class="p-tags">'+n.tags.map(t=>'<span class="p-tag">#'+t+'</span>').join('')+'</div>';
  if(n.content) h+='<div class="p-md">'+mdToHtml(n.content)+'</div>';
  const out=E.filter(e=>e.from===n.id).map(e=>e.to), inc=E.filter(e=>e.to===n.id).map(e=>e.from);
  if(out.length||inc.length){ h+='<div class="p-links">';
    if(out.length) h+='<h4>Links to</h4>'+out.map(id=>'<a data-link="'+id+'">'+(N.get(id)?N.get(id).title:id)+'</a>').join('');
    if(inc.length) h+='<h4 style="margin-top:12px">Linked from</h4>'+inc.map(id=>'<a data-link="'+id+'">'+(N.get(id)?N.get(id).title:id)+'</a>').join('');
    h+='</div>'; }
  panelIn.innerHTML=h; panel.classList.add('open'); setTimeout(size,210);
  panelIn.querySelectorAll('a[data-link]').forEach(a=>{ a.onclick=()=>{ const t=N.get(a.getAttribute('data-link')); if(t)openNode(t); }; });
}
function closePanel(){ selected=null; panel.classList.remove('open'); setTimeout(size,210); }
window.closePanel=closePanel;

const tip=document.getElementById('tip');
let downAt=null, moved=false;
function pick(px,py){ const w=fromScreen(px,py); let best=null,bd=1e9;
  for (const n of N.values()){ const d=Math.hypot(n.x-w.x,n.y-w.y); if(d<bd&&d<radius(n)/cam.z+8){bd=d;best=n;} } return best; }
c.addEventListener('mousedown', e=>{ const n=pick(e.clientX,e.clientY); moved=false; downAt={x:e.clientX,y:e.clientY};
  if(n){drag=n;}else{panning=true; last={x:e.clientX,y:e.clientY};} });
addEventListener('mousemove', e=>{
  if(downAt && Math.hypot(e.clientX-downAt.x,e.clientY-downAt.y)>4) moved=true;
  if(drag){ const w=fromScreen(e.clientX,e.clientY); drag.x=w.x; drag.y=w.y; drag.vx=drag.vy=0; }
  else if(panning){ cam.x+=e.clientX-last.x; cam.y+=e.clientY-last.y; last={x:e.clientX,y:e.clientY}; }
  else { hover=pick(e.clientX,e.clientY);
    if(hover){ const col=nodeColor(hover); tip.classList.add('show'); tip.style.left=(e.clientX+14)+'px'; tip.style.top=(e.clientY+14)+'px';
      tip.innerHTML='<div class="t">'+hover.title+'</div><div class="cat" style="color:'+col+'">'+(hover.kind==='index'?'index':(hover.category||'note'))+(hover.kind==='ghost'?' · not written':'')+'</div>'+(hover.tags&&hover.tags.length?'<div class="tags">#'+hover.tags.slice(0,6).join(' #')+'</div>':'');
      c.style.cursor='pointer';
    } else { tip.classList.remove('show'); c.style.cursor='grab'; } }
});
addEventListener('mouseup', e=>{ if(drag&&!moved) openNode(drag); drag=null; panning=false; downAt=null; });
c.addEventListener('wheel', e=>{ e.preventDefault(); const f=e.deltaY<0?1.1:0.9; cam.z=Math.max(0.2,Math.min(4,cam.z*f)); }, {passive:false});
document.getElementById('q').addEventListener('input', e=>{ query=e.target.value.toLowerCase().trim(); });
</script>
</body></html>`;

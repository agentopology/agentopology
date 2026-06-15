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
  /** "note" (real file), "ghost" (linked but not yet written), or "index" (a hub). */
  kind: "note" | "ghost" | "index";
  /** Frontmatter + inline tags on this note. */
  tags: string[];
  /** Number of inbound links (for sizing). */
  inbound: number;
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
      kind: isIndex ? "index" : "note",
      tags,
      inbound: 0,
    });

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
        nodes.set(target, { id: target, title: target, kind: "ghost", tags: [], inbound: 0 });
      }
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

/**
 * Render a brain graph as a self-contained, dependency-free HTML page with an
 * Obsidian-style force-directed graph view.
 */
export function renderBrainHtml(graph: BrainGraph): string {
  const vaultName = path.basename(graph.vaultPath.replace(/\/+$/, "")) || "brain";
  const realCount = graph.nodes.filter((n) => n.kind !== "ghost").length;
  const ghostCount = graph.nodes.filter((n) => n.kind === "ghost").length;

  const data = JSON.stringify({
    nodes: graph.nodes,
    edges: graph.edges,
    tags: graph.tags.slice(0, 24),
  });

  return BRAIN_HTML
    .replace(/__VAULT__/g, escapeHtml(vaultName))
    .replace("__NOTES__", String(realCount))
    .replace("__LINKS__", String(graph.edges.length))
    .replace("__GHOSTS__", String(ghostCount))
    .replace("__TAGS__", String(graph.tags.length))
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
 * spring, link distance). No external scripts, no build step.
 */
const BRAIN_HTML = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>__VAULT__ — Brain Graph</title>
<style>
  :root{--bg:#1a1b26;--panel:#16161e;--line:#2f3142;--text:#c0caf5;--dim:#565f89;
        --note:#7aa2f7;--ghost:#f7768e;--index:#9ece6a;--tag:#e0af68;--accent:#bb9af7}
  *{box-sizing:border-box}
  html,body{margin:0;height:100%;background:var(--bg);color:var(--text);
    font:13px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;overflow:hidden}
  #hud{position:fixed;top:14px;left:14px;z-index:10;background:#16161ecc;backdrop-filter:blur(10px);
    padding:14px 16px;border-radius:12px;border:1px solid var(--line);max-width:260px}
  #hud h1{margin:0 0 2px;font-size:15px;color:var(--accent)}
  #hud .sub{color:var(--dim);font-size:11px;margin-bottom:10px}
  #hud .stat{display:flex;justify-content:space-between;font-size:12px;padding:2px 0}
  #hud .stat b{color:var(--text)}
  .legend{margin-top:10px;border-top:1px solid var(--line);padding-top:10px}
  .legend div{display:flex;align-items:center;gap:7px;font-size:11px;color:var(--dim);padding:2px 0}
  .dot{width:9px;height:9px;border-radius:50%;flex:none}
  #search{position:fixed;top:14px;right:14px;z-index:10}
  #search input{background:#16161ecc;backdrop-filter:blur(10px);border:1px solid var(--line);
    color:var(--text);border-radius:9px;padding:8px 12px;width:200px;font-size:12px;outline:none}
  #search input:focus{border-color:var(--accent)}
  #tip{position:fixed;z-index:20;background:#16161e;border:1px solid var(--line);border-radius:8px;
    padding:7px 11px;font-size:11px;pointer-events:none;opacity:0;transition:opacity .12s;max-width:260px}
  #tip.show{opacity:1}
  #tip .t{color:var(--accent);font-weight:600}
  #tip .tags{color:var(--tag);font-size:10px;margin-top:3px}
  canvas{display:block;cursor:grab}
  canvas:active{cursor:grabbing}
  #controls{position:fixed;bottom:14px;left:14px;z-index:10;background:#16161ecc;backdrop-filter:blur(10px);
    border:1px solid var(--line);border-radius:10px;padding:10px 14px;display:flex;gap:16px;font-size:11px}
  #controls label{display:flex;flex-direction:column;gap:3px;color:var(--dim)}
  #controls input[type=range]{width:80px;accent-color:var(--accent)}
</style></head>
<body>
<div id="hud">
  <h1>🧠 __VAULT__</h1>
  <div class="sub">A brain graph — no Obsidian required</div>
  <div class="stat"><span>Notes</span><b>__NOTES__</b></div>
  <div class="stat"><span>Links</span><b>__LINKS__</b></div>
  <div class="stat"><span>Ghost nodes</span><b>__GHOSTS__</b></div>
  <div class="stat"><span>Tags</span><b>__TAGS__</b></div>
  <div class="legend">
    <div><span class="dot" style="background:var(--note)"></span>note</div>
    <div><span class="dot" style="background:var(--index)"></span>index / hub</div>
    <div><span class="dot" style="background:var(--ghost)"></span>ghost (not yet written)</div>
  </div>
</div>
<div id="search"><input id="q" placeholder="Search notes…" autocomplete="off"></div>
<div id="tip"></div>
<div id="controls">
  <label>Repel<input type="range" id="repel" min="200" max="6000" value="2200"></label>
  <label>Link dist<input type="range" id="dist" min="40" max="300" value="120"></label>
  <label>Center<input type="range" id="center" min="0" max="30" value="8"></label>
</div>
<canvas id="c"></canvas>
<script>
const DATA = __DATA__;
const c = document.getElementById('c'), x = c.getContext('2d');
let W, H, DPR = Math.min(devicePixelRatio||1, 2);
function size(){ W=innerWidth; H=innerHeight; c.width=W*DPR; c.height=H*DPR; c.style.width=W+'px'; c.style.height=H+'px'; x.setTransform(DPR,0,0,DPR,0,0); }
size(); addEventListener('resize', size);

const COL = { note:'#7aa2f7', ghost:'#f7768e', index:'#9ece6a' };
// Build node objects with positions.
const N = new Map();
for (const n of DATA.nodes){
  N.set(n.id, Object.assign({}, n, {
    x: W/2 + (Math.random()-.5)*Math.min(W,600),
    y: H/2 + (Math.random()-.5)*Math.min(H,600),
    vx:0, vy:0
  }));
}
// Only keep edges whose endpoints exist.
const E = DATA.edges.filter(e => N.has(e.from) && N.has(e.to));

// Camera (pan + zoom).
let cam = { x:0, y:0, z:1 };
let forces = { repel:2200, dist:120, center:8 };
document.getElementById('repel').oninput  = e => forces.repel  = +e.target.value;
document.getElementById('dist').oninput   = e => forces.dist   = +e.target.value;
document.getElementById('center').oninput = e => forces.center = +e.target.value / 1000;

function radius(n){ return (n.kind==='index'?7:5) + Math.min(n.inbound*1.4, 10); }

function step(){
  const nodes = [...N.values()];
  // Repel — every pair pushes apart (Obsidian repelStrength).
  for (let i=0;i<nodes.length;i++){
    const a = nodes[i];
    for (let j=i+1;j<nodes.length;j++){
      const b = nodes[j];
      let dx=a.x-b.x, dy=a.y-b.y, d2=dx*dx+dy*dy||1, d=Math.sqrt(d2);
      const f = forces.repel / d2;
      const fx=dx/d*f, fy=dy/d*f;
      a.vx+=fx; a.vy+=fy; b.vx-=fx; b.vy-=fy;
    }
  }
  // Link spring — pull connected nodes toward linkDistance (Obsidian linkStrength+linkDistance).
  for (const e of E){
    const a=N.get(e.from), b=N.get(e.to);
    let dx=b.x-a.x, dy=b.y-a.y, d=Math.hypot(dx,dy)||1;
    const f=(d-forces.dist)*0.015;
    const fx=dx/d*f, fy=dy/d*f;
    a.vx+=fx; a.vy+=fy; b.vx-=fx; b.vy-=fy;
  }
  // Center pull (Obsidian centerStrength) + integrate.
  for (const n of nodes){
    if (n===drag) continue;
    n.vx += (W/2 - n.x)*forces.center;
    n.vy += (H/2 - n.y)*forces.center;
    n.x += (n.vx*=0.82); n.y += (n.vy*=0.82);
  }
}

function toScreen(n){ return { x:(n.x-W/2)*cam.z + W/2 + cam.x, y:(n.y-H/2)*cam.z + H/2 + cam.y }; }
function fromScreen(px,py){ return { x:(px-W/2-cam.x)/cam.z + W/2, y:(py-H/2-cam.y)/cam.z + H/2 }; }

let hover=null, query='';
function draw(){
  x.clearRect(0,0,W,H);
  // Edges.
  x.lineWidth = 1;
  for (const e of E){
    const a=toScreen(N.get(e.from)), b=toScreen(N.get(e.to));
    const ghost = N.get(e.from).kind==='ghost' || N.get(e.to).kind==='ghost';
    x.strokeStyle = ghost ? 'rgba(247,118,142,.22)' : 'rgba(86,95,137,.35)';
    x.beginPath(); x.moveTo(a.x,a.y); x.lineTo(b.x,b.y); x.stroke();
  }
  // Nodes.
  for (const n of N.values()){
    const p=toScreen(n), r=radius(n)*cam.z;
    const match = query && n.title.toLowerCase().includes(query);
    x.globalAlpha = n.kind==='ghost' ? .5 : 1;
    x.beginPath(); x.arc(p.x,p.y,r,0,7); x.fillStyle=COL[n.kind]; x.fill();
    if (n.kind==='ghost'){ x.setLineDash([3,3]); x.strokeStyle=COL.ghost; x.lineWidth=1; x.stroke(); x.setLineDash([]); }
    if (match || n===hover){ x.lineWidth=2; x.strokeStyle='#fff'; x.stroke(); }
    x.globalAlpha=1;
    // Labels — only when zoomed in enough or hovered/matched.
    if (cam.z>0.65 || n===hover || match){
      x.fillStyle = (n===hover||match)?'#fff':'#a9b1d6';
      x.font = (n.kind==='index'?'600 ':'') + (11*Math.min(cam.z,1.3))+'px sans-serif';
      x.textAlign='center';
      x.fillText(n.title, p.x, p.y + r + 11);
    }
  }
}
(function loop(){ step(); draw(); requestAnimationFrame(loop); })();

// Interaction: pan, zoom, drag nodes, hover tooltip.
let drag=null, panning=false, last={x:0,y:0};
const tip=document.getElementById('tip');
function pick(px,py){
  const w=fromScreen(px,py); let best=null,bd=1e9;
  for (const n of N.values()){ const d=Math.hypot(n.x-w.x,n.y-w.y); if(d<bd&&d<radius(n)+6){bd=d;best=n;} }
  return best;
}
c.addEventListener('mousedown', e=>{
  const n=pick(e.clientX,e.clientY);
  if(n){ drag=n; } else { panning=true; last={x:e.clientX,y:e.clientY}; }
});
addEventListener('mousemove', e=>{
  if(drag){ const w=fromScreen(e.clientX,e.clientY); drag.x=w.x; drag.y=w.y; drag.vx=drag.vy=0; }
  else if(panning){ cam.x+=e.clientX-last.x; cam.y+=e.clientY-last.y; last={x:e.clientX,y:e.clientY}; }
  else {
    hover=pick(e.clientX,e.clientY);
    if(hover){ tip.classList.add('show'); tip.style.left=(e.clientX+14)+'px'; tip.style.top=(e.clientY+14)+'px';
      tip.innerHTML='<div class="t">'+hover.title+'</div>'+(hover.kind==='ghost'?'<div style="color:var(--ghost);font-size:10px">ghost — not yet written</div>':'')+(hover.tags&&hover.tags.length?'<div class="tags">#'+hover.tags.join('  #')+'</div>':''); }
    else tip.classList.remove('show');
  }
});
addEventListener('mouseup', ()=>{ drag=null; panning=false; });
c.addEventListener('wheel', e=>{ e.preventDefault(); const f=e.deltaY<0?1.1:0.9; cam.z=Math.max(0.2,Math.min(4,cam.z*f)); }, {passive:false});
document.getElementById('q').addEventListener('input', e=>{ query=e.target.value.toLowerCase().trim(); });
</script>
</body></html>`;

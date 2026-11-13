/**
 * The 0.12 lenses: Sessions, Seats, Coverage and Index. Each is a pair of page
 * functions: a model (pure, reads `data` and nothing else, so a test can read
 * it from the page) and a renderer that turns the model into HTML. None keeps
 * a second copy of a field: they read the projection (`data.nodes`, `data.edges`
 * and the rest) and the embedded facts (`data.facts`).
 *
 * The strings are page JavaScript. They are written with String.raw so a
 * backslash reaches the page as written.
 *
 * @module
 */

export const LENS_CSS = String.raw`
.sess-wrap{position:relative;margin-top:8px}
.sess-place{position:absolute;border:1px dashed rgba(167,139,250,.5);border-radius:14px;background:rgba(167,139,250,.04)}
.sess-place>.sess-title{position:absolute;left:12px;top:6px;font-family:var(--font-mono);font-size:11px;letter-spacing:1.5px;text-transform:uppercase;color:var(--purple);font-weight:600}
.sess-card{position:absolute;box-sizing:border-box;border:1px solid var(--b2);border-radius:10px;background:var(--s);padding:8px 10px;font-size:12px}
.sess-card .sess-id{font-family:var(--font-heading);font-weight:600;font-size:12px;color:var(--t)}
.sess-card .sess-model{font-family:var(--font-mono);font-size:11px;color:var(--t3)}
.sess-card.hub{border:2px solid var(--gold);box-shadow:0 0 0 3px rgba(251,191,36,.12)}
.sess-card.hub .hub-tag{font-family:var(--font-mono);font-size:11px;font-weight:700;color:var(--gold);margin-left:6px}
.sess-card.unguarded{background-image:repeating-linear-gradient(135deg,rgba(248,113,113,.18) 0 6px,transparent 6px 12px);border-color:var(--red)}
.sess-card .unguarded-tag{display:inline-block;font-family:var(--font-mono);font-size:11px;font-weight:700;color:var(--red);border:1px solid var(--red);border-radius:4px;padding:0 6px;background:var(--bg);margin-top:3px}
.sess-sub{display:block;margin-top:4px;font-family:var(--font-mono);font-size:11px;color:var(--t2);border:1px solid var(--b);border-radius:6px;padding:1px 8px;background:var(--s2)}
.decides-badge{display:inline-block;margin-top:3px;font-family:var(--font-mono);font-size:11px;color:var(--cyan);border:1px solid var(--cyan-br);border-radius:10px;padding:0 8px;background:var(--cyan-bg)}
.kind-chip{position:absolute;transform:translate(-50%,-50%);font-family:var(--font-mono);font-size:11px;color:var(--t);border:1px solid var(--b2);border-radius:10px;padding:0 8px;background:var(--bg);white-space:nowrap}
.sess-lines{position:absolute;left:0;top:0;pointer-events:none}
.sess-lines line{stroke:var(--t3);stroke-width:1.5}
.sess-guards{display:flex;gap:18px;flex-wrap:wrap;margin-bottom:10px;font-size:12px;color:var(--t2);align-items:center}
.seat-hold{font-family:var(--font-mono);font-size:11px;color:var(--t2)}
.cov-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(210px,1fr));gap:10px;margin-bottom:14px}
.cov-card{border:1px solid var(--b);border-radius:8px;padding:8px 10px;background:var(--s)}
.cov-card .cov-kind{font-family:var(--font-mono);font-size:11px;color:var(--t3);text-transform:uppercase;letter-spacing:.5px}
.cov-nums{display:flex;gap:6px;margin-top:4px;flex-wrap:wrap}
.cov-num{background:none;border:1px solid var(--b2);border-radius:10px;color:var(--t);font-family:var(--font-mono);font-size:11px;padding:0 8px;cursor:pointer}
.cov-num.on{background:var(--s2);border-color:var(--purple)}
.cov-num.mapped{border-color:var(--green)}.cov-num.unmapped{border-color:var(--gold)}.cov-num.missing{border-color:var(--red)}
.cov-list code{display:block;font-family:var(--font-mono);font-size:11px;color:var(--t2);padding:2px 0;word-break:break-all}
.idx-table{width:100%;border-collapse:collapse;font-size:12px}
.idx-table td,.idx-table th{padding:3px 10px 3px 0;border-bottom:1px solid var(--b);text-align:left}
.idx-table th{color:var(--t3);font-family:var(--font-mono);font-size:10px;text-transform:uppercase;letter-spacing:.5px}
.idx-row{cursor:pointer}.idx-row:hover{background:var(--s2)}
.idx-line{font-family:var(--font-mono);color:var(--t3)}
.src-box{margin-top:18px;border:1px solid var(--b);border-radius:8px;background:var(--s);max-height:420px;overflow:auto}
.src-line{display:flex;font-family:var(--font-mono);font-size:12px;line-height:1.5;white-space:pre}
.src-line .ln{flex:0 0 48px;text-align:right;padding-right:12px;color:var(--t3);user-select:none}
.src-line.hit{background:rgba(251,191,36,.22)}
`;

/** Shared helpers the lenses use. */
export const LENS_JS_COMMON = String.raw`
function gradeOf(id) { return factsChecked() && data.facts.guard[id] ? data.facts.guard[id].strength : null; }
function lensHead(title, sub) { return '<div class="lens-title">' + esc(title) + '</div><div class="lens-sub">' + sub + '</div>'; }
function matchesSearch(id) {
  if (!searchQuery) return true;
  var n = data.nodes.find(function(x) { return x.id === id; });
  return id.toLowerCase().indexOf(searchQuery) >= 0 || (n && (n.label || '').toLowerCase().indexOf(searchQuery) >= 0);
}
`;

export const LENS_JS_SESSIONS = String.raw`
// --- Sessions lens (VZ-6) ---
function sessionAgentNodes() { return data.nodes.filter(function(n) { return n.type === 'agent' && n.runs === 'session'; }); }
function talkEdgeList() {
  var ids = {};
  sessionAgentNodes().forEach(function(n) { ids[n.id] = true; });
  return data.edges.filter(function(e) { return !e.isError && ids[e.from] && ids[e.to]; });
}
function sessionsModel() {
  var sessions = sessionAgentNodes();
  var sessionIds = {};
  sessions.forEach(function(n) { sessionIds[n.id] = true; });
  var talks = talkEdgeList().map(function(e) { return { from: e.from, to: e.to, kind: e.message || null }; });
  // A hub is the session every other session talks to and hears from.
  var hub = null;
  if (sessions.length > 2) {
    sessions.forEach(function(c) {
      var others = sessions.filter(function(o) { return o.id !== c.id; });
      var all = others.every(function(o) {
        return talks.some(function(t) { return t.from === c.id && t.to === o.id; }) && talks.some(function(t) { return t.from === o.id && t.to === c.id; });
      });
      if (all && !hub) hub = c.id;
    });
  }
  var decisions = {};
  sessions.forEach(function(n) { (n.decides || []).forEach(function(d) { decisions[d] = n.id; }); });
  var agentIds = {};
  data.nodes.forEach(function(n) { if (n.type === 'agent' && !sessionIds[n.id]) agentIds[n.id] = true; });
  var placeNames = [];
  sessions.forEach(function(n) { var p = n.place || '(no place)'; if (placeNames.indexOf(p) < 0) placeNames.push(p); });
  var talkGrade = gradeOf('talk guard'), spawnGrade = gradeOf('spawn guard');
  var places = placeNames.map(function(p) {
    return { place: p, sessions: sessions.filter(function(n) { return (n.place || '(no place)') === p; }).map(function(n) {
      var subs = [];
      data.edges.forEach(function(e) { if (e.from === n.id && agentIds[e.to] && subs.indexOf(e.to) < 0) subs.push(e.to); });
      return { id: n.id, decides: n.decides || [], subagents: subs, unguarded: talks.length > 0 && talkGrade === 'none' && talks.some(function(t) { return t.from === n.id || t.to === n.id; }) };
    }) };
  });
  return { places: places, talks: talks, hub: hub, decisions: decisions, guards: { talk: talkGrade, spawn: spawnGrade } };
}
function renderSessionsView() {
  var m = sessionsModel();
  if (!m.places.length) return lensHead('Sessions', 'No session agents. Declare an agent with runs: session to see it here.');
  var CARD_W = 210, PAD = 18, TITLE = 30, GAP = 14, COL_GAP = 90;
  var cards = {}, boxes = [];
  var x = 12, maxY = 0;
  m.places.forEach(function(pl) {
    var y = TITLE + 6;
    pl.sessions.forEach(function(s) {
      var h = 50 + s.subagents.length * 24 + (s.decides.length ? 24 : 0) + (s.unguarded ? 24 : 0);
      cards[s.id] = { s: s, x: x + PAD, y: y, w: CARD_W, h: h };
      y += h + GAP;
    });
    boxes.push({ place: pl.place, x: x, y: 0, w: CARD_W + PAD * 2, h: y + PAD - GAP });
    maxY = Math.max(maxY, y + PAD);
    x += CARD_W + PAD * 2 + COL_GAP;
  });
  var W = x, H = maxY + 12;
  var h = lensHead('Sessions', 'Who may message whom. Places are boxes; subagents sit under the session that spawns them.');
  h += '<div class="sess-guards"><span>talk guard ' + chipHtml(m.guards.talk || '') + '</span><span>spawn guard ' + chipHtml(m.guards.spawn || '') + '</span></div>';
  h += '<div class="sess-wrap" style="width:' + W + 'px;height:' + H + 'px">';
  var lines = '', chips = '';
  var seen = {};
  m.talks.forEach(function(t) {
    var a = cards[t.from], b = cards[t.to];
    if (!a || !b) return;
    var back = m.talks.some(function(o) { return o.from === t.to && o.to === t.from; });
    var key = back ? [t.from, t.to].sort().join('|') : t.from + '>' + t.to;
    var x1 = a.x + a.w / 2, y1 = a.y + a.h / 2, x2 = b.x + b.w / 2, y2 = b.y + b.h / 2;
    var shown = !seen[key];
    seen[key] = true;
    if (shown) lines += '<line x1="' + x1 + '" y1="' + y1 + '" x2="' + x2 + '" y2="' + y2 + '"' + (back ? '' : ' stroke-dasharray="6 3"') + '/>';
    // Both directions get their own chip, a little apart, so each carries its kind.
    var off = back ? (t.from < t.to ? -11 : 11) : 0;
    chips += '<span class="kind-chip" data-from="' + esc(t.from) + '" data-to="' + esc(t.to) + '" style="left:' + ((x1 + x2) / 2) + 'px;top:' + ((y1 + y2) / 2 + off) + 'px">' + esc(t.kind || 'talk') + '</span>';
  });
  h += '<svg class="sess-lines" width="' + W + '" height="' + H + '">' + lines + '</svg>';
  boxes.forEach(function(b) {
    h += '<div class="sess-place" data-place="' + esc(b.place) + '" style="left:' + b.x + 'px;top:' + b.y + 'px;width:' + b.w + 'px;height:' + b.h + 'px"><span class="sess-title">' + esc(b.place) + '</span></div>';
  });
  Object.keys(cards).forEach(function(id) {
    var c = cards[id], s = c.s, node = data.nodes.find(function(n) { return n.id === id; });
    var cls = 'sess-card' + (m.hub === id ? ' hub' : '') + (s.unguarded ? ' unguarded' : '');
    h += '<div class="' + cls + '" data-id="' + esc(id) + '" style="left:' + c.x + 'px;top:' + c.y + 'px;width:' + c.w + 'px;height:' + c.h + 'px' + (matchesSearch(id) ? '' : ';opacity:.25') + '" onclick="onNodeClick(\'' + esc(id) + '\')">';
    h += '<span class="sess-id">' + esc(id) + '</span>' + (m.hub === id ? '<span class="hub-tag">HUB</span>' : '') + ' <span class="sess-model">' + esc(node && node.model ? node.model : '') + '</span>';
    s.decides.forEach(function(d) { h += '<br><span class="decides-badge" data-for="' + esc(id) + '">decides ' + esc(d) + '</span>'; });
    if (s.unguarded) h += '<br><span class="unguarded-tag">unguarded</span>';
    s.subagents.forEach(function(sa) { h += '<span class="sess-sub" data-for="' + esc(id) + '">' + esc(sa) + ' · subagent</span>'; });
    h += '</div>';
  });
  h += chips + '</div>';
  if (!factsChecked()) h += '<div class="lens-sub" style="margin-top:12px">Guards: not checked. Run visualize with --dir in the project to grade the talk and spawn guards.</div>';
  return h;
}
`;

export const LENS_JS_SEATS = String.raw`
// --- Seats lens (VZ-8): one row per decision point ---
function seatsModel() {
  var rows = [];
  var flowEdges = data.edges.filter(function(e) { return !e.isError; });
  data.nodes.forEach(function(n) {
    if (n.type !== 'human') return;
    var before = [], after = [];
    flowEdges.forEach(function(e) {
      if (e.to === n.id && after.indexOf(e.from) < 0) after.push(e.from);
      if (e.from === n.id && before.indexOf(e.to) < 0) before.push(e.to);
    });
    rows.push({ id: n.id, kind: 'human', where: { after: after, before: before }, releases: before.slice(), timeout: n.timeout || null, onTimeout: n.onTimeout || null, holder: null, grade: gradeOf(n.id) });
  });
  var declared = [];
  (data.decisions || []).forEach(function(d) { if (declared.indexOf(d) < 0) declared.push(d); });
  data.nodes.forEach(function(n) { (n.decides || []).forEach(function(d) { if (declared.indexOf(d) < 0) declared.push(d); }); });
  declared.forEach(function(d) {
    var holderNode = data.nodes.find(function(n) { return (n.decides || []).indexOf(d) >= 0; });
    var rel = [];
    if (holderNode) flowEdges.forEach(function(e) { if (e.from === holderNode.id && rel.indexOf(e.to) < 0) rel.push(e.to); });
    rows.push({ id: d, kind: 'decision', where: holderNode ? { place: holderNode.place || null, session: holderNode.id } : null, releases: rel, timeout: null, onTimeout: null, holder: holderNode ? holderNode.id : null, grade: gradeOf(d) });
  });
  return { rows: rows };
}
function renderSeatsView() {
  var m = seatsModel();
  var h = lensHead('Seats', 'Every decision point: a human step or a decision a session holds. Where it sits, what it releases, how long it waits.');
  if (!m.rows.length) return h + '<div class="lens-sub">No human steps or decisions are declared.</div>';
  h += '<table class="ledger"><thead><tr><th>Seat</th><th>Kind</th><th>Where it sits</th><th>Releases</th><th>Timeout</th><th>On timeout</th><th>Grade</th></tr></thead><tbody>';
  m.rows.forEach(function(r) {
    if (!matchesSearch(r.id) && !(r.holder && matchesSearch(r.holder))) return;
    var where = '';
    if (r.kind === 'human') where = 'after ' + (r.where.after.join(', ') || '(start)') + ' · before ' + (r.where.before.join(', ') || '(end)');
    else where = r.where ? 'held by ' + r.where.session + (r.where.place ? ' in ' + r.where.place : '') : 'nobody holds it';
    var grade;
    if (r.grade) grade = chipHtml(r.grade);
    else grade = factsChecked() ? '<span class="seat-hold">not graded</span>' : chipHtml('');
    var link = data.nodes.some(function(n) { return n.id === r.id; }) ? ' link" onclick="onNodeClick(\'' + esc(r.id) + '\')' : '';
    h += '<tr class="seat-row" data-seat="' + esc(r.id) + '"><td class="idcell' + link + '">' + esc(r.id) + '</td><td>' + esc(r.kind) + '</td><td class="where">' + esc(where) + '</td><td>' + esc(r.releases.join(', ') || '—') + '</td><td>' + esc(r.timeout || '—') + '</td><td>' + esc(r.onTimeout || '—') + '</td><td>' + grade + '</td></tr>';
  });
  return h + '</tbody></table>';
}
`;

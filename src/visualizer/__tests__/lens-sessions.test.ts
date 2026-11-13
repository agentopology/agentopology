import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse } from "../../parser/index.js";
import { claudeCodeBinding } from "../../bindings/claude-code.js";
import { talkEdgesOf } from "../../bindings/lib/session.js";
import { VERIFIED_ON } from "../../conformance/claude-code.js";
import { generateVisualization } from "../index.js";
import { collectFacts } from "../facts.js";
import { drawPage } from "./vm-draw.js";

const ROOT = path.resolve(__dirname, "../../..");
const SRC = fs.readFileSync(path.join(ROOT, "src/__tests__/e2e/fixtures/session-ops.at"), "utf8");
const ast = parse(SRC);

let scaffolded: string, bare: string;
let prevEnv: string | undefined;
beforeAll(() => {
  prevEnv = process.env.AGENTOPOLOGY_CLAUDE_VERSION;
  process.env.AGENTOPOLOGY_CLAUDE_VERSION = VERIFIED_ON;
  scaffolded = fs.mkdtempSync(path.join(os.tmpdir(), "viz-sess-"));
  bare = fs.mkdtempSync(path.join(os.tmpdir(), "viz-sess-bare-"));
  for (const f of claudeCodeBinding.scaffold(ast)) {
    const p = path.join(scaffolded, f.path);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, f.content);
    if (f.executable || f.path.endsWith(".sh")) fs.chmodSync(p, 0o755);
  }
});
afterAll(() => {
  if (prevEnv === undefined) delete process.env.AGENTOPOLOGY_CLAUDE_VERSION;
  else process.env.AGENTOPOLOGY_CLAUDE_VERSION = prevEnv;
  fs.rmSync(scaffolded, { recursive: true, force: true });
  fs.rmSync(bare, { recursive: true, force: true });
});

const page = (dir?: string) => drawPage(generateVisualization(ast, { facts: collectFacts(ast, { source: SRC, dir }) }));

describe("[VZ6] the sessions lens, read from the page data", () => {
  it("[VZ-6] which sessions may message which matches the talk edges the binding compiles", () => {
    const m = page().read<any>("sessionsModel()");
    const pageTalks = m.talks.map((t: any) => `${t.from}->${t.to}:${t.kind ?? ""}`).sort();
    const compiled = talkEdgesOf(ast).map((e) => `${e.from}->${e.to}:${e.message ?? ""}`).sort();
    expect(pageTalks).toEqual(compiled);
    expect(pageTalks.length).toBeGreaterThan(0);
  });

  it("[VZ-6] which session decides each declared decision", () => {
    const m = page().read<any>("sessionsModel()");
    expect(m.decisions).toEqual({ "package-yes": "lane-manager" });
  });

  it("[VZ-6] places are titled boxes holding their sessions, subagents nested", () => {
    const m = page().read<any>("sessionsModel()");
    const byPlace = Object.fromEntries(m.places.map((p: any) => [p.place, p.sessions.map((s: any) => s.id).sort()]));
    expect(byPlace).toEqual({ ops: ["lane-build", "lane-manager"], makers: ["lane-text", "lane-video"] });
    const build = m.places.flatMap((p: any) => p.sessions).find((s: any) => s.id === "lane-build");
    expect(build.subagents).toEqual(["helper"]);
    const html = page().read<string>("renderSessionsView()");
    expect(html).toMatch(/class="sess-place"[^>]*data-place="ops"/);
    expect(html).toMatch(/class="sess-sub"[^>]*data-for="lane-build"/);
  });

  it("[VZ-6] talk: hub draws as a hub, and each talk edge carries its message kind as a chip", () => {
    const p = page();
    expect(p.read<any>("sessionsModel()").hub).toBe("lane-manager");
    const html = p.read<string>("renderSessionsView()");
    expect(html).toMatch(/class="sess-card hub"[^>]*data-id="lane-manager"/);
    expect(html).toMatch(/class="kind-chip"[^>]*data-from="lane-manager"[^>]*data-to="lane-build"[^>]*>ticket</);
  });

  it("[VZ-6] decides: shows a badge on the session", () => {
    const html = page().read<string>("renderSessionsView()");
    expect(html).toMatch(/class="decides-badge"[^>]*data-for="lane-manager"[^>]*>decides package-yes</);
  });

  it("[VZ-6] a session with no talk guard on disk is hatched unguarded; with the guard on disk it is not", () => {
    const bareHtml = page(bare).read<string>("renderSessionsView()");
    expect(bareHtml).toMatch(/class="sess-card[^"]*unguarded[^"]*"[^>]*data-id="lane-build"/);
    expect(bareHtml).toContain(">unguarded<");
    const okHtml = page(scaffolded).read<string>("renderSessionsView()");
    expect(okHtml).not.toContain(">unguarded<");
  });

  it("[VZ-6] send and spawn guard grades come from the facts; with no project dir they read not checked", () => {
    const g = page(scaffolded).read<any>("sessionsModel().guards");
    expect(g).toEqual({ talk: "refuse", spawn: "refuse" });
    const none = page(bare).read<any>("sessionsModel().guards");
    expect(none).toEqual({ talk: "none", spawn: "none" });
    const nc = page();
    expect(nc.read<any>("sessionsModel().guards")).toEqual({ talk: null, spawn: null });
    const html = nc.read<string>("renderSessionsView()");
    expect(html).toContain("not checked");
    expect(html).not.toContain(">unguarded<");
  });
});

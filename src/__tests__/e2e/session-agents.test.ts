/**
 * Session agents: grammar and validate (N44a, T-03, L-1).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "../../parser/index.js";
import { validate } from "../../parser/validator.js";
import { serializeAST } from "../../import/serializer.js";
import { topics } from "../../docs/content.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = readFileSync(resolve(here, "fixtures/session-ops.at"), "utf8");

const run = (src: string) => validate(parse(src));
const msgs = (src: string) => run(src).map((r) => `${r.level}: ${r.message}`);
const errors = (src: string) => run(src).filter((r) => r.level === "error");
const warnings = (src: string) => run(src).filter((r) => r.level === "warning");

/** Fixture with a string replaced once; fails loudly if the anchor moved. */
function variant(from: string, to: string): string {
  if (!fixture.includes(from)) throw new Error(`fixture anchor missing: ${from}`);
  return fixture.replace(from, to);
}

describe("[N44a] grammar", () => {
  it("[N44a] runs: session and place parse; default stays subagent (unset)", () => {
    const ast = parse(fixture);
    const mgr = ast.nodes.find((n) => n.id === "lane-manager") as any;
    expect(mgr.runs).toBe("session");
    expect(mgr.place).toBe("ops");
    expect(mgr.decides).toEqual(["package-yes"]);
    expect((ast.nodes.find((n) => n.id === "helper") as any).runs).toBeUndefined();
    expect(ast.decisions).toEqual(["package-yes"]);
  });

  it("[N44a] talk: hub expands in the parser to edges each way, with [message:] kept", () => {
    const ast = parse(fixture);
    const sess = ["lane-build", "lane-video", "lane-text"];
    for (const s of sess) {
      expect(ast.edges.some((e) => e.from === "lane-manager" && e.to === s)).toBe(true);
      expect(ast.edges.some((e) => e.from === s && e.to === "lane-manager")).toBe(true);
    }
    const marked = ast.edges.filter((e) => (e as any).message === "ticket");
    expect(marked).toHaveLength(1);
    expect(marked[0].from).toBe("lane-manager");
    expect(marked[0].to).toBe("lane-build");
    // no duplicate manager -> build edge
    expect(ast.edges.filter((e) => e.from === "lane-manager" && e.to === "lane-build")).toHaveLength(1);
  });

  it("[N44a] talk: all expands to an edge each way between every session pair", () => {
    const src = variant("talk: hub lane-manager", "talk: all").replace(": [hub]", ": [mesh]");
    const ast = parse(src);
    const s = ["lane-manager", "lane-build", "lane-video", "lane-text"];
    for (const a of s) for (const b of s) {
      if (a !== b) expect(ast.edges.some((e) => e.from === a && e.to === b), `${a}->${b}`).toBe(true);
    }
  });

  it("[N44a] [message: ticket | report | ask] on an edge; another value is an error", () => {
    expect(errors(variant("[message: ticket]", "[message: report]"))).toEqual([]);
    expect(errors(variant("[message: ticket]", "[message: ask]"))).toEqual([]);
    const bad = errors(variant("[message: ticket]", "[message: shout]"));
    expect(bad.map((r) => r.message).join("\n")).toMatch(/message/);
  });
});

describe("[N44a] validate", () => {
  it("[N44a] the fixture validates with no errors and the expected warnings", () => {
    expect(errors(fixture)).toEqual([]);
    expect(warnings(fixture)).toEqual([]);
  });

  it("[N44a] a session agent id that is not kebab-case is an error", () => {
    const src = fixture.replaceAll("lane-video", "LaneVideo");
    const e = errors(src);
    expect(e.some((r) => /kebab/i.test(r.message) && r.node === "LaneVideo")).toBe(true);
  });

  it("[N44a] runs: other than session|subagent|inline|fork is an error", () => {
    expect(errors(variant("runs: session\n    place: makers\n  }\n\n  agent lane-text", "runs: sesion\n    place: makers\n  }\n\n  agent lane-text")).length).toBeGreaterThan(0);
  });

  it("[N44a] no talk edges among session agents warns 'talk not declared: unguarded'", () => {
    const src = variant("    lane-manager -> lane-build [message: ticket]\n    talk: hub lane-manager\n", "");
    expect(warnings(src).map((r) => r.message)).toContain("talk not declared: unguarded");
  });

  it("[N44a] two agents claiming one decision warn", () => {
    const src = variant("    place: makers\n  }\n\n  agent lane-text", "    place: makers\n    decides: [package-yes]\n  }\n\n  agent lane-text");
    const w = warnings(src).map((r) => r.message).join("\n");
    expect(w).toMatch(/package-yes/);
    expect(w).toMatch(/lane-manager/);
    expect(w).toMatch(/lane-video/);
  });

  it("[N44a] a decision in decisions: with no agent claiming it warns", () => {
    const src = variant("decisions: [package-yes]", "decisions: [package-yes, ship-it]");
    const w = warnings(src).map((r) => r.message);
    expect(w.some((m) => m.includes("ship-it"))).toBe(true);
    expect(w.some((m) => m.includes("package-yes"))).toBe(false);
  });

  it("[N44a] with : [hub], a session edge that touches no hub node warns naming the edge", () => {
    const src = variant("    lane-build -> helper\n", "    lane-build -> helper\n    lane-build -> lane-video\n");
    const w = warnings(src).map((r) => r.message);
    expect(w.some((m) => m.includes("lane-build -> lane-video"))).toBe(true);
  });

  it("[N44a] T-03: background, skills and permissions on a session agent warn once each", () => {
    const src = variant(
      "    place: makers\n  }\n\n  agent lane-text",
      "    place: makers\n    background: true\n    skills: [cut]\n    permissions: plan\n  }\n\n  agent lane-text",
    );
    const w = warnings(src).filter((r) => /ignored when run as a session/.test(r.message));
    expect(w).toHaveLength(3);
    for (const f of ["background", "skills", "permissions"]) {
      expect(w.filter((r) => r.message.includes(f))).toHaveLength(1);
    }
    expect(w.every((r) => r.node === "lane-video")).toBe(true);
  });

  it("[N44a] L-1: permission-mode must be a known mode", () => {
    const ok = variant("runs: session\n    place: ops\n    decides", "runs: session\n    place: ops\n    permission-mode: acceptEdits\n    decides");
    expect(errors(ok)).toEqual([]);
    const bad = variant("runs: session\n    place: ops\n    decides", "runs: session\n    place: ops\n    permission-mode: yolo\n    decides");
    expect(errors(bad).some((r) => /permission-mode/.test(r.message))).toBe(true);
  });

  it("[N44a] L-1: a talk edge whose ends declare different modes warns", () => {
    const src = variant("    place: ops\n    decides", "    place: ops\n    permission-mode: plan\n    decides")
      .replace("runs: session\n    place: makers\n  }\n\n  agent lane-text", "runs: session\n    permission-mode: auto\n    place: makers\n  }\n\n  agent lane-text");
    const w = warnings(src).map((r) => r.message);
    expect(w.some((m) => m.includes("a session in another permission mode holds incoming messages for its user, so this edge may not arrive"))).toBe(true);
  });

  it("[N44a] same mode on both ends does not warn", () => {
    const src = fixture.replace(/runs: session/g, "runs: session\n    permission-mode: auto");
    expect(warnings(src)).toEqual([]);
  });
});

describe("[N44a] round trip and docs", () => {
  it("[N44a] parse -> serialize -> parse is equal for the new fields", () => {
    const a = parse(fixture);
    const b = parse(serializeAST(a));
    const pick = (ast: any) => ({
      nodes: ast.nodes.map((n: any) => ({ id: n.id, runs: n.runs, place: n.place, decides: n.decides, pm: n.permissionMode })),
      edges: ast.edges.map((e: any) => [e.from, e.to, e.message ?? null]),
      decisions: ast.decisions,
    });
    expect(pick(b)).toEqual(pick(a));
  });

  it("[N44a] permission-mode round-trips", () => {
    const src = fixture.replace(/(lane-text \{[^}]*runs: session)/, "$1\n    permission-mode: plan");
    const a = parse(src);
    expect((a.nodes.find((n) => n.id === "lane-text") as any).permissionMode).toBe("plan");
    expect((parse(serializeAST(a)).nodes.find((n) => n.id === "lane-text") as any).permissionMode).toBe("plan");
  });

  it("[N44a] docs: agent lists the new fields; flow covers talk and [message:]", () => {
    const agent = topics.agent.content();
    for (const f of ["runs", "place", "decides", "permission-mode"]) expect(agent).toContain(f);
    const flow = topics.flow.content();
    expect(flow).toContain("talk");
    expect(flow).toContain("message");
  });
});

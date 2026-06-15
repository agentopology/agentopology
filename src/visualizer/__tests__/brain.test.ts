import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parseBrainVault, renderBrainHtml } from "../brain.js";

/**
 * Builds a throwaway vault on disk, runs the parser against it, and tears it
 * down. Exercises the real file-walking + link/tag extraction logic.
 */
describe("Brain visualizer — vault parser", () => {
  let vault: string;

  beforeAll(() => {
    vault = fs.mkdtempSync(path.join(os.tmpdir(), "brain-test-"));

    fs.writeFileSync(
      path.join(vault, "_brain.md"),
      `---\ntags:\n  - brain/index\n---\n\n# Brain\n\n- [[acme-corp]]\n- [[deal]]\n`
    );
    fs.writeFileSync(
      path.join(vault, "acme-corp.md"),
      `---\ntags:\n  - client/enterprise\n  - status/active\n---\n\n# Acme Corp\n\nClosed the [[deal|Q3 deal]] with [[dana]]. On [[enterprise-pricing]].\n`
    );
    fs.writeFileSync(
      path.join(vault, "deal.md"),
      `---\ntags: [deal/closed, client/enterprise]\n---\n\n# Q3 Deal\n\nWith [[acme-corp]]. Tagged #revenue inline.\n`
    );
    // enterprise-pricing.md and dana.md intentionally NOT created → ghost nodes.
  });

  afterAll(() => {
    fs.rmSync(vault, { recursive: true, force: true });
  });

  it("treats each .md file as a node and links as edges", () => {
    const g = parseBrainVault(vault);
    const realIds = g.nodes.filter((n) => n.kind !== "ghost").map((n) => n.id).sort();
    expect(realIds).toEqual(["_brain", "acme-corp", "deal"]);
    // acme-corp -> deal, acme-corp -> dana, acme-corp -> enterprise-pricing, etc.
    expect(g.edges.some((e) => e.from === "acme-corp" && e.to === "deal")).toBe(true);
    expect(g.edges.some((e) => e.from === "deal" && e.to === "acme-corp")).toBe(true);
  });

  it("detects ghost nodes (linked but no file)", () => {
    const g = parseBrainVault(vault);
    const ghosts = g.nodes.filter((n) => n.kind === "ghost").map((n) => n.id).sort();
    expect(ghosts).toEqual(["dana", "enterprise-pricing"]);
  });

  it("marks index/hub notes (underscore prefix or brain/index tag)", () => {
    const g = parseBrainVault(vault);
    expect(g.nodes.find((n) => n.id === "_brain")?.kind).toBe("index");
  });

  it("parses list-form AND inline-array frontmatter tags, plus inline #tags", () => {
    const g = parseBrainVault(vault);
    const acme = g.nodes.find((n) => n.id === "acme-corp");
    expect(acme?.tags).toContain("client/enterprise"); // list form
    expect(acme?.tags).toContain("status/active");
    const deal = g.nodes.find((n) => n.id === "deal");
    expect(deal?.tags).toContain("deal/closed"); // inline-array form
    expect(deal?.tags).toContain("revenue"); // inline #tag in body
  });

  it("dedupes repeated links within a note (one edge per pair)", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "brain-dup-"));
    fs.writeFileSync(path.join(dir, "a.md"), `# A\n[[b]] and again [[b]] and [[b|once more]].\n`);
    fs.writeFileSync(path.join(dir, "b.md"), `# B\n`);
    const g = parseBrainVault(dir);
    expect(g.edges.filter((e) => e.from === "a" && e.to === "b")).toHaveLength(1);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("uses the first # heading as the node title, falls back to the slug", () => {
    const g = parseBrainVault(vault);
    expect(g.nodes.find((n) => n.id === "acme-corp")?.title).toBe("Acme Corp");
    expect(g.nodes.find((n) => n.id === "dana")?.title).toBe("dana"); // ghost → slug
  });

  it("renders a self-contained HTML page with the graph data inlined", () => {
    const g = parseBrainVault(vault);
    const html = renderBrainHtml(g);
    expect(html).toContain("<!doctype html>");
    expect(html).not.toContain("<script src"); // no external scripts — fully self-contained
    expect(html).toContain('"acme-corp"'); // node data inlined
  });

  it("declares interaction state (drag) before the animation loop that reads it", () => {
    // Regression: `let drag` is in a temporal dead zone until its line runs.
    // step() reads `drag` every frame, so if the loop starts before `let drag`,
    // the first frame throws "Cannot access 'drag' before initialization" and
    // the canvas never renders. Guard the declaration order.
    const html = renderBrainHtml(parseBrainVault(vault));
    const dragDecl = html.indexOf("let drag");
    const loopStart = html.indexOf("function loop()");
    expect(dragDecl).toBeGreaterThan(-1);
    expect(loopStart).toBeGreaterThan(-1);
    expect(dragDecl).toBeLessThan(loopStart);
  });

  it("initializes center force at the integrator's scale (not the raw slider value)", () => {
    // Regression: the slider stores value/1000; the initial value must match or
    // the first frames fling every node off-screen before it settles.
    const html = renderBrainHtml(parseBrainVault(vault));
    expect(html).toContain("center:0.008");
    expect(html).not.toMatch(/center:8\b/);
  });

  it("infers ghost CATEGORY from namespaced tags (a person stays a person)", () => {
    // A note tagged person/x, org/y, topic/z tells us the category of the
    // ghost slugs x, y, z even though their notes don't exist. This is what
    // makes Amitai a 'person' node, not a generic 'ghost'.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "brain-cat-"));
    fs.writeFileSync(
      path.join(dir, "meeting.md"),
      `---\ntags:\n  - person/amitai\n  - org/acme\n  - topic/litigation-ai\n---\n# Meeting\n[[amitai]] from [[acme]] re [[litigation-ai]].\n`
    );
    const g = parseBrainVault(dir);
    const byId = Object.fromEntries(g.nodes.map((n) => [n.id, n]));
    expect(byId["amitai"].kind).toBe("ghost");
    expect(byId["amitai"].category).toBe("person"); // not a generic ghost — a person
    expect(byId["acme"].category).toBe("org");
    expect(byId["litigation-ai"].category).toBe("topic");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("inlines note content for offline click-to-open (no server needed)", () => {
    const g = parseBrainVault(vault);
    const acme = g.nodes.find((n) => n.id === "acme-corp");
    expect(acme?.content).toContain("Acme Corp"); // body inlined into the node
    const html = renderBrainHtml(g);
    expect(html).toContain("openNode"); // the click-to-open handler is present
  });

  it("emits a topology back-link when given a topologyHref", () => {
    const html = renderBrainHtml(parseBrainVault(vault), {
      topologyHref: "company-brain-team-topology.html",
      topologyName: "company-brain-team",
    });
    expect(html).toContain('class="back-link"');
    expect(html).toContain("company-brain-team-topology.html");
  });
});

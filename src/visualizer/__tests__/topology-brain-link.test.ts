import { describe, it, expect } from "vitest";
import { parse } from "../../parser/index.js";
import { generateVisualization } from "../index.js";

/** A minimal topology with one brain store. */
const ONE_BRAIN = `topology cb : [brain] {
  meta {
    version: "1.0.0"
    description: "x"
  }
  memory { store brain {
    type: brain
    path: "brain/"
    format: obsidian
  } }
  agent lib {
    model: sonnet
    description: "k"
    tools: [Read, Write]
    custodian-of: [brain]
  }
  action intake {
    kind: inline
    description: "in"
  }
  flow { intake -> lib }
}`;

describe("Topology visualizer — brain cross-link", () => {
  // Note: `brain-link` / `brain-menu-list` appear as CSS class definitions in
  // the stylesheet regardless. Assert on the actual RENDERED anchors instead.
  it("renders no brain anchor when no brains are passed", () => {
    const html = generateVisualization(parse(ONE_BRAIN));
    expect(html).not.toContain("Open Brain");
    expect(html).not.toMatch(/\d+ Brains ▾/);
  });

  it("renders a single 'Open Brain →' button for one brain", () => {
    const html = generateVisualization(parse(ONE_BRAIN), {
      brains: [{ id: "brain", href: "cb-brain-brain.html" }],
    });
    expect(html).toContain("Open Brain");
    expect(html).toContain('href="cb-brain-brain.html"');
    expect(html).not.toMatch(/\d+ Brains ▾/); // single → button, not dropdown
  });

  it("renders a dropdown listing each brain when there are several", () => {
    const html = generateVisualization(parse(ONE_BRAIN), {
      brains: [
        { id: "client-brain", href: "cb-brain-client-brain.html" },
        { id: "internal-brain", href: "cb-brain-internal-brain.html" },
      ],
    });
    expect(html).toContain("2 Brains ▾");
    expect(html).toContain('href="cb-brain-client-brain.html"');
    expect(html).toContain('href="cb-brain-internal-brain.html"');
    expect(html).not.toContain("Open Brain"); // dropdown, not single button
  });
});

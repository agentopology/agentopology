/**
 * An unphased agent must sort the same way on every target.
 *
 * Regression: six consumers each picked their own sentinel — MAX_SAFE_INTEGER
 * in claude-code and claude-workflow, 999 in gemini-cli, 0 in openclaw, kiro,
 * mermaid and the markdown exporter. So the same topology put an unphased
 * agent LAST on three targets and FIRST on three others. That is exactly the
 * failure "write once, deploy to any platform" exists to prevent, and nothing
 * compared them.
 */

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "../../parser/index.js";
import { phaseOf, byPhase, UNPHASED } from "../phase.js";
import type { AgentNode } from "../../parser/ast.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

const MIXED = `topology t : [pipeline] {
  meta {
    version: "1.0.0"
    description: "one phased agent, one not"
  }
  agent early {
    model: sonnet
    description: "e"
    phase: 1
  }
  agent unphased {
    model: sonnet
    description: "u"
  }
  action i {
    kind: inline
    description: "in"
  }
  flow { i -> early -> unphased }
}`;

describe("phase resolution is defined in exactly one place", () => {
  it("gives an unphased agent a key no real declaration can reach", () => {
    // 999 collides with `phase: 999`; 0 collides with `phase: 0`. This cannot
    // collide, because `phase` is parseFloat'd from a source literal.
    expect(UNPHASED).toBe(Number.MAX_SAFE_INTEGER);
  });

  it("trails unphased agents rather than leading them", () => {
    const agents = parse(MIXED).nodes.filter((n): n is AgentNode => n.type === "agent");
    const sorted = [...agents].sort(byPhase).map((a) => a.id);
    expect(sorted).toEqual(["early", "unphased"]);
  });

  it("leaves declaration order intact when nobody declares a phase", () => {
    const src = MIXED.replace("    phase: 1\n", "");
    const agents = parse(src).nodes.filter((n): n is AgentNode => n.type === "agent");
    expect(agents.every((a) => phaseOf(a) === UNPHASED)).toBe(true);
    expect([...agents].sort(byPhase).map((a) => a.id)).toEqual(["early", "unphased"]);
  });

  it("no consumer defines its own phase fallback", () => {
    // The guard that actually prevents the regression: grep the source. A new
    // `agent.phase ?? <n>` anywhere reintroduces the divergence silently.
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === "__tests__" || entry.name === "node_modules") continue;
          walk(p);
          continue;
        }
        if (!entry.name.endsWith(".ts")) continue;
        if (p.endsWith(join("resolve", "phase.ts"))) continue;
        const text = readFileSync(p, "utf8");
        if (/\bphase\s*\?\?\s*/.test(text)) offenders.push(p.slice(root.length + 1));
      }
    };
    walk(join(root, "src"));
    expect(
      offenders,
      `these define their own phase fallback instead of using resolve/phase.ts: ${offenders.join(", ")}`
    ).toEqual([]);
  });
});

/**
 * Bindings must agree with the spec's defaults table, and with each other.
 *
 * Regression: `spec/grammar.md:1717` says `agent.permissions` defaults to
 * `autonomous`. `codex.ts` defaulted to `supervised` at two sites, which maps
 * to Codex `untrusted` — the MOST restrictive approval policy. So a topology
 * that simply omitted `permissions` scaffolded to a Codex agent that asks
 * permission for everything, which is not what the language says it means.
 *
 * The failure mode this guards against is subtle: each binding filling its own
 * blanks inline, drifting from the spec and from each other, with nothing
 * comparing them. `src/resolve/defaults.ts` is the single source; these tests
 * assert the bindings do not contradict it.
 */

import { describe, it, expect } from "vitest";
import { parse } from "../../parser/index.js";
import { resolveDefaults } from "../../resolve/defaults.js";
import { bindings } from "../index.js";
import type { AgentNode } from "../../parser/ast.js";

/** A topology that declares NO optional agent fields, so every default shows. */
const BARE = `topology bare : [pipeline] {
  meta { version: "1.0.0" description: "declares no optional agent fields" }
  agent worker {
    model: sonnet
    description: "does the work"
  }
  action intake {
    kind: inline
    description: "entry"
  }
  flow { intake -> worker }
}`;

describe("bindings agree with the spec's defaults table", () => {
  it("the resolver uses the spec value for permissions", () => {
    const { ast } = resolveDefaults(parse(BARE));
    const worker = ast.nodes.find((n) => n.id === "worker") as AgentNode;
    expect(worker.permissions).toBe("autonomous");
  });

  it("no binding emits the MOST restrictive policy for an omitted permissions", () => {
    const ast = parse(BARE);

    // Codex maps `supervised` → `untrusted` and `autonomous` → `on-request`.
    // An omitted field must not silently become the strictest setting.
    const codexFiles = bindings["codex"].scaffold(ast);
    const toml = codexFiles.find((f) => f.path.endsWith(".toml"));
    expect(toml, "codex should emit a config.toml").toBeDefined();
    expect(toml!.content).toContain('approval_policy = "on-request"');
    expect(toml!.content).not.toContain('approval_policy = "untrusted"');
  });

  it("every binding scaffolds a bare topology without throwing", () => {
    const ast = parse(BARE);
    for (const [name, binding] of Object.entries(bindings)) {
      expect(() => binding.scaffold(ast), name).not.toThrow();
      expect(binding.scaffold(ast).length, name).toBeGreaterThan(0);
    }
  });

  it("an explicitly declared permission still wins over the default", () => {
    const src = BARE.replace(
      '    description: "does the work"',
      '    description: "does the work"\n    permissions: supervised'
    );
    const toml = bindings["codex"]
      .scaffold(parse(src))
      .find((f) => f.path.endsWith(".toml"));
    // Declared `supervised` must still map to `untrusted` — the fix changes the
    // DEFAULT, not the mapping.
    expect(toml!.content).toContain('approval_policy = "untrusted"');
  });

  it("openclaw's `auto` fallback resolves to the same meaning as the spec", () => {
    // openclaw falls back to the literal "auto", but its mapPermissions turns
    // "auto" into "autonomous" — so it agrees with the spec despite the
    // different literal. Asserted so a future refactor of the mapping cannot
    // silently change the meaning.
    const files = bindings["openclaw"].scaffold(parse(BARE));
    const withPermissions = files.find((f) => f.content.includes("Permission model:"));
    if (withPermissions) {
      expect(withPermissions.content).toContain("autonomous");
      expect(withPermissions.content).not.toContain("Permission model: supervised");
    }
  });
});

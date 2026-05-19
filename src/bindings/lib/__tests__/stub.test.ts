/**
 * Tests for the shared stub utility (src/bindings/lib/stub.ts).
 *
 * Covers Issue #4: shellStub() emits a machine-readable AGENTOPOLOGY_STUB
 * marker line, and isStubContent() detects it.
 */

import { describe, it, expect } from "vitest";
import { shellStub, isStubContent, STUB_MARKER } from "../stub.js";

describe("shellStub", () => {
  it("emits a bash shebang", () => {
    expect(shellStub("Test").startsWith("#!/usr/bin/env bash")).toBe(true);
  });

  it("emits the description in a comment", () => {
    expect(shellStub("Gate: quality-check")).toContain("# Gate: quality-check");
  });

  it("emits the AGENTOPOLOGY_STUB marker line", () => {
    expect(shellStub("anything")).toContain(STUB_MARKER);
  });

  it("emits `set -euo pipefail`", () => {
    expect(shellStub("x")).toContain("set -euo pipefail");
  });

  it("emits a TODO placeholder echo", () => {
    expect(shellStub("x")).toContain('echo "TODO: implement this script"');
  });

  it("produces deterministic output (same input → same output)", () => {
    expect(shellStub("Gate: x")).toBe(shellStub("Gate: x"));
  });
});

describe("isStubContent", () => {
  it("returns true for any output from shellStub", () => {
    expect(isStubContent(shellStub("foo"))).toBe(true);
  });

  it("returns false for an empty string", () => {
    expect(isStubContent("")).toBe(false);
  });

  it("returns false for a script that doesn't contain the marker", () => {
    const realScript = [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      "echo hello",
    ].join("\n");
    expect(isStubContent(realScript)).toBe(false);
  });

  it("returns false once the marker is stripped (canonical 'implemented' signal)", () => {
    // The user removes the marker line after implementing the script.
    const implemented = shellStub("Gate: x")
      .split("\n")
      .filter((line) => !line.includes(STUB_MARKER))
      .join("\n");
    expect(isStubContent(implemented)).toBe(false);
  });

  it("returns true even when other text surrounds the marker", () => {
    // Marker is a substring match, not a full-line match.
    const content = `arbitrary text\n${STUB_MARKER}\nmore text`;
    expect(isStubContent(content)).toBe(true);
  });
});

describe("STUB_MARKER (stability contract)", () => {
  it("is the exact string downstream tooling matches on", () => {
    // Pin the literal string. Changing this breaks gate-runners, CI scripts,
    // and any user automation grepping for it — bump a major version if you
    // ever need to change it.
    expect(STUB_MARKER).toBe(
      "# AGENTOPOLOGY_STUB — fill this in before relying on this script",
    );
  });
});

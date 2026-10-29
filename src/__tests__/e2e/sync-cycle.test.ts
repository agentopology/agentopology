/**
 * scaffold → sync is a fixed point: with no edits the .at comes back
 * unchanged, and an edit comes back once.
 *
 * Sync used to copy everything from "## Instructions" to the next heading it
 * knew, so generated sections and headings scaffold had pushed one level down
 * went into the .at: the prompt grew on every cycle (N11).
 */

import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "../../parser/index.js";
import { claudeCodeBinding } from "../../bindings/claude-code.js";
import { syncFromPlatform } from "../../sync/index.js";
import { fencedPrompt } from "../../bindings/lib/prompt-fence.js";
import { mergeAgentFile } from "../../scaffold/merge.js";

const here = dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(resolve(here, "fixtures/hazards.at"), "utf-8");

const agentFiles = (at: string) =>
  claudeCodeBinding.scaffold(parse(at)).filter((f) => /agents\/[^/]+\/AGENT\.md$/.test(f.path));
const sync = (at: string, files: { path: string; content: string }[]) => syncFromPlatform(at, files, "claude-code");

describe("scaffold then sync is a fixed point", () => {
  it("[N11] with no edits, three cycles leave the .at byte-identical", () => {
    let at = source;
    for (let i = 0; i < 3; i++) at = sync(at, agentFiles(at));
    expect(at).toBe(source);
  });

  it("[N11] an edit between the markers comes back once, headings at their own level", () => {
    const files = agentFiles(source).map((f) =>
      f.path.endsWith("researcher/AGENT.md")
        ? { ...f, content: f.content.replace("- Prioritize recent and authoritative sources", "- Prefer primary sources") }
        : f,
    );
    const once = sync(source, files);
    const researcher = parse(once).nodes.find((n) => n.id === "researcher") as { prompt?: string };
    expect(researcher.prompt).toContain("- Prefer primary sources");
    expect(researcher.prompt).toContain("## Guidelines");
    expect(researcher.prompt).not.toContain("### Guidelines");
    // and the next cycle changes nothing more
    expect(sync(once, agentFiles(once))).toBe(once);
  });

  it("[N11] re-scaffold keeps the user's text between the markers and regenerates the rest", () => {
    const generated = agentFiles(source).find((f) => f.path.endsWith("writer/AGENT.md"))!.content;
    const edited = generated.replace(fencedPrompt(generated)!, "My own instructions.");
    const merged = mergeAgentFile(edited, generated.replace("## Reads", "## Reads\n- workspace/new.md"), "claude-code");
    expect(fencedPrompt(merged)).toBe("My own instructions.");
    expect(merged).toContain("- workspace/new.md");
  });
});

/**
 * S-13: the forms that kept `import` from writing a valid .at for a project
 * that holds several topologies side by side (several topology skills, a
 * topology .at beside them). Every fixture is synthetic: small files written
 * for the test that reproduce one failing FORM, not any project's file.
 */
import { describe, it, expect } from "vitest";
import { parse } from "../../parser/index.js";
import { validate } from "../../parser/validator.js";
import { importFromPlatform } from "../index.js";
import type { PlatformFile } from "../../sync/index.js";

function file(path: string, content: string): PlatformFile {
  return { path, content } as PlatformFile;
}

function agent(id: string): PlatformFile {
  return file(`.claude/agents/${id}.md`, `---\nname: ${id}\ndescription: ${id} agent\nmodel: sonnet\n---\n\nYou are ${id}.\n`);
}

/** A topology skill with an orchestrator and a flow, as scaffold writes it. */
function topologySkill(name: string, handles: string[], flow: string[]): PlatformFile {
  return file(
    `.claude/skills/${name}/SKILL.md`,
    [
      "---",
      `name: ${name}`,
      `topology: ${name}`,
      'version: "1.0.0"',
      `description: ${name} team`,
      "---",
      "",
      "## Orchestrator",
      "",
      "Model: opus",
      `Handles: ${handles.join(", ")}`,
      "",
      "## Flow",
      "",
      ...flow.map((e) => `- ${e}`),
      "",
    ].join("\n"),
  );
}

function errors(source: string): string[] {
  return validate(parse(source))
    .filter((r) => r.level === "error")
    .map((r) => `${r.rule}: ${r.message}`);
}

describe("[S-13] V9: every action a merged flow uses is handled by the one orchestrator", () => {
  it("a second topology skill's orchestrator handles are kept", () => {
    const files = [
      agent("alpha-writer"),
      agent("beta-writer"),
      topologySkill("alpha-team", ["alpha-start"], ["alpha-start -> alpha-writer"]),
      topologySkill("beta-team", ["beta-start"], ["beta-start -> beta-writer"]),
    ];
    const source = importFromPlatform(files, "claude-code", "two-teams");
    expect(errors(source)).toEqual([]);
    const orch = parse(source).nodes.find((n) => n.type === "orchestrator") as { handles: string[] };
    expect(orch.handles).toEqual(expect.arrayContaining(["alpha-start", "beta-start"]));
  });
});

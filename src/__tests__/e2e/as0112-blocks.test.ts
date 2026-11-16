/**
 * The reverse of differential-0112's normalization (compile-runs.mjs as0112): the 0.11.4 guard scripts
 * DO hold each literal block it undoes, exactly once, so the undo can never silently become a no-op.
 * And a script missing a block, or holding one twice, makes as0112 throw.
 */

import { describe, it, expect } from "vitest";
import { parse } from "../../parser/index.js";
import { claudeCodeBinding } from "../../bindings/claude-code.js";
import { codexBinding } from "../../bindings/codex.js";
// @ts-expect-error plain JavaScript module, shared with freeze.mjs
import { BLOCKS_0114, as0112 } from "./differential/compile-runs.mjs";
// @ts-expect-error plain JavaScript module, shared with freeze-hooks.mjs
import { TOPOLOGIES } from "./differential/hook-corpus.mjs";

const IF_TOPOLOGY = `topology t : [pipeline] {
  meta { version: "1.0.0" description: "d" }
  orchestrator { model: gpt-5.2 handles: [a] }
  agent a { model: gpt-5.2 description: "x" }
  hooks {
    hook h {
      on: PreToolUse
      matcher: "Bash"
      strength: refuse
      if: "Bash(git push*)"
      run: "scripts/h.sh"
    }
  }
  flow { a -> a }
}
`;

const quiet = <T>(fn: () => T): T => { const w = console.warn; console.warn = () => {}; try { return fn(); } finally { console.warn = w; } };
const src = (id: string) => TOPOLOGIES.find((t: { id: string }) => t.id === id).src();
const file = (files: Array<{ path: string; content: string }>, name: string) => {
  const f = files.find((x) => x.path.endsWith(`/${name}`));
  if (!f) throw new Error(`no ${name}`);
  return { path: f.path, content: String(f.content) };
};
const count = (text: string, part: string) => text.split(part).length - 1;
const indent = (block: string, ind: string) => block.split("\n").map((l) => ind + l).join("\n");

const cc = (id: string) => quiet(() => claudeCodeBinding.scaffold(parse(src(id))));
const cx = (s: string) => quiet(() => codexBinding.scaffold(parse(s)));

const SCRIPTS = () => [
  { hook: "before-action.sh", reader: "", ...file(cc("factory"), "before-action.sh") },
  { hook: "before-action.sh", reader: "", ...file(cc("ship"), "before-action.sh") },
  { hook: "before-edit.sh", reader: null, ...file(cc("ship"), "before-edit.sh") },
  { hook: "before-agent.sh", reader: null, ...file(cc("compile"), "before-agent.sh") },
  { hook: "before-action.sh", reader: "", ...file(cx(src("cxgates")), "before-action.sh") },
  { hook: "before-edit.sh", reader: null, ...file(cx(src("cxgates")), "before-edit.sh") },
  { hook: "before-agent.sh", reader: null, ...file(cx(src("cxgates")), "before-agent.sh") },
  { hook: null, reader: "  ", ...file(cx(IF_TOPOLOGY), "at-if.sh") },
];

describe("[0.11.4] the 0.11.4 guard scripts hold every block differential-0112 undoes", () => {
  it("each script holds its no-jq head and tail, and the reader blocks, exactly once", () => {
    for (const s of SCRIPTS()) {
      if (s.hook) {
        expect(count(s.content, BLOCKS_0114.noJqHead[s.hook]), `${s.path}: no-jq head`).toBe(1);
        expect(count(s.content, BLOCKS_0114.noJqTail[s.hook]), `${s.path}: no-jq tail`).toBe(1);
      }
      if (s.reader !== null) {
        expect(count(s.content, indent(BLOCKS_0114.atSpecial, s.reader)), `${s.path}: at_special`).toBe(1);
        expect(count(s.content, indent(BLOCKS_0114.atGitRead, s.reader)), `${s.path}: at_git_read`).toBe(1);
        expect(count(s.content, s.reader + BLOCKS_0114.loop), `${s.path}: at_git_read call`).toBe(1);
        expect(count(s.content, indent(BLOCKS_0114.atGitAlias, s.reader)), `${s.path}: at_git_alias`).toBe(1);
        expect(count(s.content, s.reader + BLOCKS_0114.aliasCall), `${s.path}: at_git_alias call`).toBe(1);
      }
      if (s.hook === "before-action.sh") expect(s.content.match(/^AT_GIT_STEPS='[^'\n]*'$/gm), s.path).toHaveLength(1);
      // the undo changes the text and leaves none of the blocks behind
      const undone = as0112(s.path, s.content, true);
      expect(undone, s.path).not.toBe(s.content);
      expect(undone).not.toContain("at_git_read");
      expect(undone).not.toContain("at_git_alias");
      expect(undone).not.toContain("# No jq (0.11.4)");
      expect(undone).not.toContain("AT_GIT_STEPS=");
    }
  });

  it("a script missing a block, or holding one twice, makes the undo throw", () => {
    const action = file(cc("factory"), "before-action.sh");
    expect(() => as0112(action.path, action.content.replace(BLOCKS_0114.loop, "# gone"), true)).toThrow(/at_git_read call occurs 0 times/);
    expect(() => as0112(action.path, action.content + "\n" + BLOCKS_0114.atSpecial, true)).toThrow(/at_special occurs 2 times/);
    const edit = file(cc("ship"), "before-edit.sh");
    expect(() => as0112(edit.path, edit.content.replace(BLOCKS_0114.noJqTail["before-edit.sh"], ""), true)).toThrow(/no-jq block occurs 0 times/);
    expect(() => as0112("x/other.sh", "at_git_read", true)).toThrow(/holds a 0.11.4 guard block/);
  });

  it("off (a 0.11.2 or 0.11.3 build), the text is used as is", () => {
    const action = file(cc("factory"), "before-action.sh");
    expect(as0112(action.path, action.content, false)).toBe(action.content);
  });
});

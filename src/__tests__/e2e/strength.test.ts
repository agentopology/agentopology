/**
 * How strongly a step is enforced, written in the file (N32).
 *
 * `strength: refuse | detect | hope | none` says what stops a step: code or a
 * hook refuses it, a critic detects it after the fact, prose hopes, or
 * nothing. `by: code | hook | settings | gate` says which mechanism. A gate or
 * hook can cite the code that refuses (`at: "file:line"`, `match:` the text
 * expected there) and name its way around (`bypass:`). A flow edge can cite
 * its guard (`[guard: lock-bash]`) or write its strength down
 * (`[strength: none]`), so an absence is declared rather than implied.
 *
 * The validator checks the words and the references (V104 to V106). Whether
 * the cited code is there and says what `match:` claims is read from disk by
 * `guard --check`, not here: validate never reads the project.
 */

import { describe, it, expect } from "vitest";
import { parse } from "../../parser/index.js";
import { validate } from "../../parser/validator.js";
import { serializeAST } from "../../import/serializer.js";

const topology = (gateExtra = "", flowExtra = "", hookExtra = "") => `topology strong : [pipeline] {
  meta {
    version: "1.0.0"
    description: "Strength probe"
  }

  orchestrator {
    model: sonnet
    handles: [publish]
  }

  agent writer {
    model: sonnet
    description: "Writes the post"
    prompt {
      Write the post.
    }
  }

  action publish {
    kind: external
    description: "Posts it"
    commands: ["./media post"]
  }

  hooks {
    hook lock-bash {
      on: PreToolUse
      matcher: "Bash"
      run: "harness/lock/hook.py"
${hookExtra}    }
  }

  gates {
    gate doctrine {
      after: writer
      before: publish
      run: "scripts/doctrine.sh"
      on-fail: halt
${gateExtra}    }
  }

  flow {
    writer -> publish${flowExtra}
  }
}
`;

const errors = (src: string, rule: string) => validate(parse(src)).filter((r) => r.rule === rule && r.level === "error");

describe("strength is read, not dropped", () => {
  it("[N32] a gate's strength, by, at, match and bypass are read", () => {
    const ast = parse(topology(`      strength: refuse\n      by: code\n      at: "pxframes.py:949"\n      match: "PX_ALLOW_NO_DOCTRINE"\n      bypass: "PX_ALLOW_NO_DOCTRINE"\n`));
    const gate = ast.nodes.find((n) => n.id === "doctrine") as any;
    expect(gate).toMatchObject({ strength: "refuse", by: "code", at: "pxframes.py:949", match: "PX_ALLOW_NO_DOCTRINE", bypass: "PX_ALLOW_NO_DOCTRINE" });
    expect(validate(ast).filter((r) => r.level === "error")).toEqual([]);
  });

  it("[N32] a hook's strength and bypass are read", () => {
    const ast = parse(topology("", "", `      strength: refuse\n      bypass: "AT_UNLOCK"\n`));
    expect(ast.hooks[0]).toMatchObject({ strength: "refuse", bypass: "AT_UNLOCK" });
  });

  it("[N32] an edge's strength, at and guard are read, alone or after when", () => {
    expect(parse(topology("", " [strength: none]")).edges[0]).toMatchObject({ from: "writer", to: "publish", strength: "none" });
    expect(parse(topology("", ' [strength: hope, at: "story/SKILL.md"]')).edges[0]).toMatchObject({ strength: "hope", at: "story/SKILL.md" });
    expect(parse(topology("", " [guard: lock-bash]")).edges[0]).toMatchObject({ to: "publish", guard: ["lock-bash"] });
    expect(parse(topology("", " [guard: [lock-bash, doctrine]]")).edges[0]).toMatchObject({ to: "publish", guard: ["lock-bash", "doctrine"] });
    const e = parse(topology("", " [when writer.verdict == done, guard: lock-bash]")).edges[0];
    expect(e).toMatchObject({ to: "publish", condition: "writer.verdict == done", guard: ["lock-bash"] });
  });

  it("[N32] V102 accepts the new fields", () => {
    const src = topology(`      strength: refuse\n      by: code\n      at: "x.py:1"\n      match: "y"\n      bypass: "z"\n`, " [guard: lock-bash]", `      strength: refuse\n      bypass: "AT_UNLOCK"\n`);
    expect(errors(src, "V102")).toEqual([]);
  });

  it("[N32] everything round-trips through serialize and parse", () => {
    const src = topology(`      strength: refuse\n      by: code\n      at: "pxframes.py:949"\n      match: "PX_ALLOW"\n      bypass: "PX_ALLOW"\n`, ' [when writer.verdict == done, strength: hope, at: "story/SKILL.md", guard: [lock-bash, doctrine]]', `      strength: refuse\n      bypass: "AT_UNLOCK"\n`);
    const once = parse(src);
    const twice = parse(serializeAST(once));
    expect(twice.edges).toEqual(once.edges);
    expect(twice.hooks).toEqual(once.hooks);
    expect(twice.nodes.find((n) => n.id === "doctrine")).toEqual(once.nodes.find((n) => n.id === "doctrine"));
  });
});

describe("the validator checks the words and the references", () => {
  it("[N32] V104: an unknown strength or by is an error, on a gate, a hook and an edge", () => {
    expect(errors(topology("      strength: maybe\n"), "V104")[0]?.message).toMatch(/maybe.*refuse, detect, hope, none/);
    expect(errors(topology("      by: magic\n"), "V104")[0]?.message).toMatch(/magic.*code, hook, settings, gate/);
    expect(errors(topology("", "", "      strength: strong\n"), "V104")).toHaveLength(1);
    expect(errors(topology("", " [strength: solid]"), "V104")).toHaveLength(1);
  });

  it("[N32] V105: an edge's guard names a hook or gate the file declares", () => {
    expect(errors(topology("", " [guard: lock-bash]"), "V105")).toEqual([]);
    expect(errors(topology("", " [guard: doctrine]"), "V105")).toEqual([]);
    const e = errors(topology("", " [guard: [lock-bash, lock-chrome]]"), "V105");
    expect(e).toHaveLength(1);
    expect(e[0].message).toContain("lock-chrome");
  });

  it("[N32] V106: an at: citation is a safe project-relative path, with an optional :line", () => {
    expect(errors(topology('      at: "pxframes.py:949"\n'), "V106")).toEqual([]);
    expect(errors(topology('      at: "story/SKILL.md"\n'), "V106")).toEqual([]);
    expect(errors(topology('      at: "../other/x.py:3"\n'), "V106")).toHaveLength(1);
    expect(errors(topology('      at: "/etc/x.py"\n'), "V106")).toHaveLength(1);
    expect(errors(topology('      at: "x.py:twelve"\n'), "V106")).toHaveLength(1);
    expect(errors(topology("", ' [strength: hope, at: "../x.md"]'), "V106")).toHaveLength(1);
  });

  it("[N32] a match: without an at: is an error: there is nowhere to look for it", () => {
    expect(errors(topology('      match: "PX_ALLOW"\n'), "V106")[0]?.message).toMatch(/match.*at/);
  });

  it("[N32] a file with none of this is unaffected", () => {
    const r = validate(parse(topology()));
    expect(r.filter((x) => ["V104", "V105", "V106"].includes(x.rule))).toEqual([]);
  });
});

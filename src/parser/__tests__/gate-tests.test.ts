/**
 * A gate (and a hook) carries its tests, its mode and its let-go rule.
 *
 *   tests { refuse: ["<command>", ..]  allow: ["<command>", ..] }
 *   mode: shadow | refuse
 *   let-go: once        (with the human it names: `lift:`, or the human the gate follows)
 *
 * These are read by the parser, accepted by the field check (V102), and
 * checked by V137 (tests) and V138 (mode and let-go).
 */

import { describe, it, expect } from "vitest";
import { parse } from "../index.js";
import { validate } from "../validator.js";
import type { GateNode } from "../ast.js";

const topo = (gate: string, extra = "") => `topology ship : [pipeline] {
  meta { version: "1.0.0" description: "Render then publish" }
  orchestrator { model: sonnet handles: [render, publish] }
  action render {
    kind: external
    commands: ["./tool render"]
  }
  action publish {
    kind: external
    commands: ["./tool publish"]
    unit-from: "./tool publish (\\S+)"
  }
  human sign { description: "ok to publish" }
  records {
    record trace { path: "logs/{unit}/trace.jsonl" }
  }
  gates {
    gate publish-ready {
${gate}
    }
  }
  flow { render -> publish }
${extra}}
`;

const BASE = `      after: render
      before: publish
      ledger: trace
      on-fail: halt`;

const errors = (src: string, rule?: string) =>
  validate(parse(src)).filter((r) => r.level === "error" && (!rule || r.rule === rule));

describe("gate tests, mode and let-go parse", () => {
  it("reads tests, mode, let-go and lift on a gate", () => {
    const ast = parse(topo(`${BASE}
      mode: shadow
      let-go: once
      lift: sign
      tests {
        refuse: ["./tool publish ep1", "./tool publish ep2"]
        allow: ["./tool render ep1"]
      }`));
    const g = ast.nodes.find((n) => n.id === "publish-ready") as GateNode;
    expect(g.tests).toEqual({ refuse: ["./tool publish ep1", "./tool publish ep2"], allow: ["./tool render ep1"] });
    expect(g.mode).toBe("shadow");
    expect(g.letGo).toBe("once");
    expect(g.lift).toBe("sign");
  });

  it("is not reported by the field check (V102)", () => {
    const src = topo(`${BASE}
      mode: shadow
      let-go: once
      lift: sign
      tests { refuse: ["./tool publish ep1"] }`);
    expect(errors(src, "V102")).toEqual([]);
  });

  it("reads tests on a hook", () => {
    const src = topo(BASE, `  hooks {
    hook no-rm {
      on: PreToolUse
      matcher: "Bash"
      run: "scripts/no-rm.sh"
      tests { refuse: ["rm -rf /"] allow: ["ls"] }
    }
  }
`);
    const ast = parse(src);
    expect(ast.hooks[0].tests).toEqual({ refuse: ["rm -rf /"], allow: ["ls"] });
    expect(errors(src, "V102")).toEqual([]);
  });

  it("a valid gate with tests has no V137 or V138 error", () => {
    const src = topo(`${BASE}
      mode: refuse
      let-go: once
      lift: sign
      tests { refuse: ["./tool publish ep1"] allow: ["./tool render ep1"] }`);
    expect(errors(src, "V137")).toEqual([]);
    expect(errors(src, "V138")).toEqual([]);
  });
});

describe("V137: tests need a check that runs", () => {
  it("errors on tests on a gate no generated check runs", () => {
    // after and before are both humans/none: no before-action or before-agent check holds this gate
    const src = `topology t : [pipeline] {
  meta { version: "1.0.0" description: "x" }
  orchestrator { model: sonnet handles: [a] }
  agent a { model: sonnet description: "a" prompt { Do a. } }
  agent b { model: sonnet description: "b" prompt { Do b. } }
  gates {
    gate g {
      after: a
      before: b
      run: "scripts/g.sh"
      tests { refuse: ["b"] }
    }
  }
  flow { a -> b }
}
`;
    const e = errors(src, "V137");
    expect(e).toHaveLength(1);
    expect(e[0].node).toBe("g");
    expect(e[0].message).toMatch(/tests/);
  });

  it("errors on a tests row that is not text, an empty tests block, and a hook that is not a PreToolUse command hook", () => {
    expect(errors(topo(`${BASE}
      tests { }`), "V137")).toHaveLength(1);
    const hook = (on: string, extra = "") => topo(BASE, `  hooks {
    hook h {
      on: ${on}
      matcher: "Bash"
      run: "scripts/h.sh"
      ${extra}
      tests { refuse: ["rm -rf /"] }
    }
  }
`);
    expect(errors(hook("PreToolUse"), "V137")).toEqual([]);
    expect(errors(hook("SessionStart"), "V137")).toHaveLength(1);
    expect(errors(hook("PreToolUse", "type: prompt"), "V137")).toHaveLength(1);
  });
});

describe("V138: mode and let-go", () => {
  it("errors on a mode that is not shadow or refuse", () => {
    const e = errors(topo(`${BASE}
      mode: loud`), "V138");
    expect(e).toHaveLength(1);
    expect(e[0].message).toMatch(/shadow/);
  });

  it("errors on let-go that is not once", () => {
    expect(errors(topo(`${BASE}
      let-go: always
      lift: sign`), "V138")).toHaveLength(1);
  });

  it("errors on let-go with no human to give it", () => {
    const e = errors(topo(`${BASE}
      let-go: once`), "V138");
    expect(e).toHaveLength(1);
    expect(e[0].message).toMatch(/human/);
  });

  it("errors on lift naming a node that is not a human", () => {
    expect(errors(topo(`${BASE}
      let-go: once
      lift: render`), "V138")).toHaveLength(1);
  });

  it("accepts the human the gate follows as the one who lets go", () => {
    const src = `topology t : [pipeline] {
  meta { version: "1.0.0" description: "x" }
  orchestrator { model: sonnet handles: [sign, publish] }
  human sign { description: "ok" }
  action publish { kind: external commands: ["./tool publish"] }
  records { record trace { path: "logs/trace.jsonl" } }
  gates {
    gate g {
      after: sign
      before: publish
      ledger: trace
      let-go: once
    }
  }
  flow { sign -> publish }
}
`;
    expect(errors(src, "V138")).toEqual([]);
  });

  it("errors on mode or let-go on a gate no generated check holds", () => {
    const src = `topology t : [pipeline] {
  meta { version: "1.0.0" description: "x" }
  orchestrator { model: sonnet handles: [a] }
  human sign { description: "ok" }
  agent a { model: sonnet description: "a" prompt { Do a. } }
  agent b { model: sonnet description: "b" prompt { Do b. } }
  gates {
    gate g {
      after: a
      before: b
      run: "scripts/g.sh"
      mode: shadow
    }
  }
  flow { a -> b }
}
`;
    const e = errors(src, "V138");
    expect(e).toHaveLength(1);
    expect(e[0].node).toBe("g");
  });

  it("errors on let-go when the ledger path needs a unit and the gate holds an agent launch", () => {
    const src = `topology t : [pipeline] {
  meta { version: "1.0.0" description: "x" }
  orchestrator { model: sonnet handles: [render, b] }
  action render { kind: external commands: ["./tool render"] }
  human sign { description: "ok" }
  agent b { model: sonnet description: "b" prompt { Do b. } }
  records { record trace { path: "logs/{unit}/trace.jsonl" } }
  gates {
    gate g {
      after: render
      before: b
      run: "scripts/g.sh"
      ledger: trace
      let-go: once
      lift: sign
    }
  }
  flow { render -> b }
}
`;
    expect(errors(src, "V138")).toHaveLength(1);
  });
});

/**
 * Import forms: every documented form parses, at file top level and in the body (T02b).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "../../parser/index.js";
import { validate } from "../../parser/validator.js";
import { serializeAST as serialize } from "../../import/serializer.js";

const topo = (name: string, inBody = "", top = "") => `${top}
topology ${name} : [pipeline] {
  meta {
    version: "1.0.0"
    description: "t"
  }
  orchestrator {
    model: sonnet
    handles: [a]
  }
  agent a {
    model: sonnet
    description: "d"
  }
  ${inBody}
  flow {
    orchestrator -> a
  }
}
`;

let dir: string;
const w = (name: string, body: string) => {
  const p = join(dir, name);
  writeFileSync(p, body);
  return p;
};
const check = (file: string) => validate(parse(readFileSync(file, "utf8")), { filePath: file });
const V8 = (rs: ReturnType<typeof validate>) => rs.filter((r) => r.rule === "V8");

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "at-import-forms-"));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const HASH = "abc123def456";
const FORMS: Array<[string, string, Record<string, unknown>]> = [
  ["bare path", "import reviewer from ./review.at", { alias: "reviewer", source: "./review.at" }],
  ["quoted path", 'import reviewer from "./review.at"', { alias: "reviewer", source: "./review.at" }],
  [
    "registry",
    "import linter from registry:@org/linter@1.2.0",
    { alias: "linter", registry: true, registryPackage: "@org/linter", registryVersion: "1.2.0" },
  ],
  [
    "sha256 bare",
    `import auditor from ./audit.at sha256 "${HASH}"`,
    { alias: "auditor", source: "./audit.at", sha256: HASH },
  ],
  [
    "sha256 colon",
    `import auditor from ./audit.at sha256: "${HASH}"`,
    { alias: "auditor", source: "./audit.at", sha256: HASH },
  ],
  ["legacy as", 'import "./old.at" as old', { alias: "old", source: "./old.at" }],
];

describe("[T02b] each documented import form parses", () => {
  for (const [label, line, want] of FORMS) {
    it(`[T02b] ${label}: inside the body`, () => {
      const ast = parse(topo("t", line));
      expect(ast.imports).toHaveLength(1);
      expect(ast.imports[0]).toMatchObject(want);
    });
    it(`[T02b] ${label}: above the header`, () => {
      const ast = parse(topo("t", "", line));
      expect(ast.imports).toHaveLength(1);
      expect(ast.imports[0]).toMatchObject(want);
    });
  }
});

describe("[T02b] top-level imports are resolved by validate", () => {
  it("[T02b] a missing file above the header is a V8 file-not-found error", () => {
    const main = w("m1.at", topo("m1", "", 'import making from "./missing.at"'));
    const r = V8(check(main));
    expect(r.some((x) => x.level === "error" && /file not found/.test(x.message))).toBe(true);
  });

  it("[T02b] a good top-level import passes", () => {
    w("good.at", topo("good"));
    const main = w("m2.at", topo("m2", "", 'import making from "./good.at"'));
    expect(V8(check(main))).toEqual([]);
  });

  it("[T02b] errors in a top-level imported file are reported under its path", () => {
    w("bad.at", topo("bad").replace("orchestrator -> a", "orchestrator -> ghost"));
    const main = w("m3.at", topo("m3", "", 'import making from "./bad.at"'));
    const r = V8(check(main));
    expect(r.some((x) => x.level === "error" && x.message.includes("./bad.at") && /ghost/.test(x.message))).toBe(true);
  });

  it("[T02b] a from-form sha256 mismatch is an error and a match passes", () => {
    const sub = w("hashed.at", topo("hashed"));
    const good = createHash("sha256").update(readFileSync(sub)).digest("hex");
    const ok = w("m4.at", topo("m4", `import h from ./hashed.at sha256 "${good}"`));
    expect(V8(check(ok))).toEqual([]);
    const bad = w("m5.at", topo("m5", `import h from ./hashed.at sha256 "${"0".repeat(64)}"`));
    expect(V8(check(bad)).some((x) => x.level === "error" && /sha256/.test(x.message))).toBe(true);
  });

  it("[T02b] a registry import is not read from disk and is reported as not checked", () => {
    const main = w("m6.at", topo("m6", "", "import linter from registry:@org/linter@1.2.0"));
    const r = V8(check(main));
    expect(r.some((x) => /registry import not checked/.test(x.message))).toBe(true);
    expect(r.some((x) => x.level === "error")).toBe(false);
  });

  it("[T02b] `import garbage here` is a V8 error, above the header and in the body", () => {
    for (const [name, src] of [
      ["g1", topo("g1", "", "import garbage here")],
      ["g2", topo("g2", "import garbage here")],
    ]) {
      const r = V8(validate(parse(src), {}));
      expect(r.some((x) => x.level === "error" && /unrecognized import form/.test(x.message)), name).toBe(true);
    }
  });
});

describe("[T02b] round trip keeps imports", () => {
  it("[T02b] parse -> serialize -> parse keeps every import", () => {
    const src = topo(
      "rt",
      [
        "import reviewer from ./review.at",
        `import auditor from "./audit.at" sha256 "${HASH}"`,
        "import linter from registry:@org/linter@1.2.0",
      ].join("\n  "),
      "import top from ./top.at",
    );
    const a = parse(src);
    expect(a.imports).toHaveLength(4);
    const b = parse(serialize(a));
    expect(b.imports.map((i) => ({ ...i }))).toEqual(a.imports.map((i) => ({ ...i })));
  });
});

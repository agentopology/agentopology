/**
 * Import resolution at validate time (N43, T-02) and model aliases (L-3).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "../../parser/index.js";
import { validate } from "../../parser/validator.js";

const topo = (name: string, imports = "", extra = "", model = "sonnet") => `
topology ${name} : [pipeline] {
  meta {
    version: "1.0.0"
    description: "t"
  }
  ${extra}
  orchestrator {
    model: ${model}
    handles: [a]
  }
  agent a {
    model: ${model}
    description: "d"
  }
  ${imports}
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
const check = (file: string) =>
  validate(parse(require("node:fs").readFileSync(file, "utf8")), { filePath: file });
const V8 = (rs: ReturnType<typeof validate>) => rs.filter((r) => r.rule === "V8");

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "at-imports-"));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("[N43] imports resolve at validate time", () => {
  it("[N43] a good import passes with no V8 result", () => {
    w("tiny.at", topo("tiny"));
    const main = w("good.at", topo("good", `import "./tiny.at" as tiny`));
    expect(V8(check(main))).toEqual([]);
  });

  it("[N43] a missing file is a V8 error", () => {
    const main = w("missing.at", topo("missing", `import "./nope.at" as nope`));
    const r = V8(check(main));
    expect(r).toHaveLength(1);
    expect(r[0].level).toBe("error");
    expect(r[0].message).toContain("./nope.at");
  });

  it("[N43] errors in the imported file are reported under its path", () => {
    w("broken.at", topo("broken", "", "", "sonnet").replace("orchestrator -> a", "orchestrator -> ghost"));
    const main = w("uses-broken.at", topo("ub", `import "./broken.at" as broken`));
    const r = V8(check(main));
    expect(r.length).toBeGreaterThan(0);
    expect(r.every((x) => x.level === "error")).toBe(true);
    expect(r.some((x) => x.message.includes("./broken.at") && /ghost/.test(x.message))).toBe(true);
  });

  it("[N43] a wrong sha256 is an error; the right one passes", () => {
    const body = topo("pinned");
    const p = w("pinned.at", body);
    const good = createHash("sha256").update(body).digest("hex");
    const bad = w("bad-sha.at", topo("bs", `import "./pinned.at" as pinned sha256: "${"0".repeat(64)}"`));
    const ok = w("ok-sha.at", topo("os", `import "./pinned.at" as pinned sha256: "${good}"`));
    const rb = V8(check(bad));
    expect(rb).toHaveLength(1);
    expect(rb[0].level).toBe("error");
    expect(rb[0].message).toMatch(/sha256/);
    expect(V8(check(ok))).toEqual([]);
    expect(p).toBeTruthy();
  });

  it("[N43] an import cycle is an error", () => {
    w("cyc-a.at", topo("cyca", `import "./cyc-b.at" as b`));
    w("cyc-b.at", topo("cycb", `import "./cyc-a.at" as a`));
    const r = V8(check(join(dir, "cyc-a.at")));
    expect(r.some((x) => x.level === "error" && /cycle/i.test(x.message))).toBe(true);
  });

  it("[T02] with no file path, resolution is skipped and says imports not checked", () => {
    const r = validate(parse(topo("s", `import "./nope.at" as nope`)));
    const v8 = V8(r);
    expect(v8).toHaveLength(1);
    expect(v8[0].level).toBe("warning");
    expect(v8[0].message).toBe("imports not checked");
  });

  it("[T02] no imports, no V8 result either way", () => {
    expect(V8(validate(parse(topo("plain"))))).toEqual([]);
  });
});

describe("[L3] model aliases", () => {
  const v119 = (src: string) => validate(parse(src)).filter((r) => r.rule === "V119");

  it("[L3] pin-models true warns once per alias used", () => {
    const src = topo("pin", "", "pin-models: true", "opus").replace(
      "agent a {",
      "agent b {\n    model: haiku\n    description: \"d\"\n  }\n  agent a {",
    );
    const r = v119(src);
    expect(r.map((x) => x.level)).toEqual(["warning", "warning"]);
    expect(r.some((x) => x.message.includes("opus"))).toBe(true);
    expect(r.some((x) => x.message.includes("haiku"))).toBe(true);
    expect(r[0].message).toContain("alias resolves differently over time; use the exact id for a pinned run");
  });

  it("[L3] inherit and exact ids are fine", () => {
    expect(v119(topo("p2", "", "pin-models: true", "claude-sonnet-5-5"))).toEqual([]);
    expect(v119(topo("p3", "", "pin-models: true", "inherit"))).toEqual([]);
  });

  it("[L3] without pin-models, no warning", () => {
    expect(v119(topo("p4", "", "", "opus"))).toEqual([]);
  });
});

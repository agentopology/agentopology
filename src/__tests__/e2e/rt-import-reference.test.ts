/**
 * differential/rt-import-0113.json is 0.11.3's reviewed import reference.
 * One entry moved by ruling: rt 2, a quoted script word holding a blank,
 * which import now reports as a hook it can't compile faithfully (exit 2 as
 * before; the output gains that error). Every other entry is pinned here by
 * hash, so no other entry can move with it unseen.
 */

import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const rows = (JSON.parse(fs.readFileSync(join(here, "differential/rt-import-0113.json"), "utf-8")) as {
  rows: Array<{ name: string; import: { code: number | null; output: string } }>;
}).rows;

const MOVED = 'rt 2: bash "$CLAUDE_PROJECT_DIR/.claude/hooks/my guard.sh" --flag "a b"';

describe("the rt import reference moves only where ruled", () => {
  it("every entry but rt 2 is the reviewed one, byte for byte", () => {
    const others = rows.filter((r) => r.name !== MOVED);
    expect(others.length).toBe(57);
    expect(createHash("sha256").update(JSON.stringify(others)).digest("hex")).toBe(
      "b579f181b7d7eb524db0d5de96a4d93b98779e71600e505e3182f9599a9248db",
    );
  });

  it("rt 2 still exits 2 and now names the hook it can't compile faithfully", () => {
    const rt2 = rows.find((r) => r.name === MOVED);
    expect(rt2?.import.code).toBe(2);
    expect(rt2?.import.output).toContain(
      '  ERROR Hook "pre-tool-use-bash": this hook can\'t be compiled faithfully; keep it as a hand-written hook or rewrite it as a topology script\n' +
        '    bash "$CLAUDE_PROJECT_DIR/.claude/hooks/my guard.sh" --flag "a b"\n',
    );
  });
});

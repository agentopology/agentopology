import { describe, it, expect } from "vitest";
import { parseRange, satisfiesRange } from "../range.js";

describe("version ranges", () => {
  it.each([
    ["0.13.0", ">=0.13.0", true],
    ["0.12.6", ">=0.13.0", false],
    ["0.13.0", ">0.13.0", false],
    ["0.13.1", ">0.13.0", true],
    ["0.13.0", "<=0.13.0", true],
    ["0.13.1", "<0.13.1", false],
    ["0.13.0", "=0.13.0", true],
    ["0.13.0", "0.13.0", true],
    ["0.13.9", "^0.13.0", true],
    ["0.14.0", "^0.13.0", false],
    ["1.9.0", "^1.2.3", true],
    ["2.0.0", "^1.2.3", false],
    ["0.0.3", "^0.0.3", true],
    ["0.0.4", "^0.0.3", false],
    ["0.13.5", ">=0.13.0 <0.14.0", true],
    ["0.14.0", ">=0.13.0 <0.14.0", false],
    ["0.13.0-rc.1", ">=0.13.0", true],
  ])("%s against %s is %s", (v, r, want) => {
    expect(satisfiesRange(v, r)).toBe(want);
  });

  it.each(["", "banana", ">=", ">=1.0", "~1.0.0", "1.x", ">= 1.0.0"])("%j is not a range", (r) => {
    expect(parseRange(r)).toBeNull();
  });
});

/**
 * The merge-differential's unescaped-quote-warning exception is narrow: it
 * maps back exactly one V96 quote warning (with its lesson) and nothing else,
 * so any other difference in the output stays red in the caller.
 */

import { describe, it, expect } from "vitest";
import { unescapedQuoteValidate } from "./differential/unescaped-quote.js";

const TEXT = '`\\"` reaches the command unescaped; this check may never pass or refuse as written';
const W = `  WARN  [V96] Hook "h" "run": ${TEXT}\n\n  0 error(s), 1 warning(s)\n\n`;
const L = "  ── how to write it ──────────────────────────────────\n\n  [V96]\n    # run is the command\n    → agentopology docs gate\n\n";
const HEAD = "Validating t.at (t v1.0.0)\n\n";
const PASS = HEAD + "  All validation rules passed.\n\n";

describe("the unescaped-quote-warning exception is narrow", () => {
  it("maps the one warning and its lesson back to the pass line", () => {
    expect(unescapedQuoteValidate(HEAD + W + L)).toBe(PASS);
  });

  it("refuses two warnings, a missing lesson, or another rule's warning", () => {
    expect(unescapedQuoteValidate(HEAD + W + W + L)).toBeNull();
    expect(unescapedQuoteValidate(HEAD + W)).toBeNull();
    expect(unescapedQuoteValidate(HEAD + W.replace("V96", "V130") + L)).toBeNull();
  });

  it("an extra line elsewhere survives the mapping, so the caller's comparison stays red", () => {
    expect(unescapedQuoteValidate(HEAD + "  WARN  [V1] other\n\n" + W + L)).not.toBe(PASS);
  });
});

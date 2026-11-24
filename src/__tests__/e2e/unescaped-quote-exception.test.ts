/**
 * The merge-differential's unescaped-quote-warning exception is narrow: it
 * maps back exactly one V96 quote warning (with its lesson) and nothing else,
 * so any other difference in the output stays red in the caller.
 */

import { describe, it, expect } from "vitest";
import { unescapedQuoteImport, unescapedQuoteValidate } from "./differential/unescaped-quote.js";
import { lessonsFor } from "../../docs/teach.js";

const TEXT = '`\\"` reaches the command unescaped; this check may never pass or refuse as written';
const W = `  WARN  [V96] Hook "h" "run": ${TEXT}\n\n  0 error(s), 1 warning(s)\n\n`;
/** V96's lesson exactly as validate prints it (printLessons, no colour). */
const V96 = lessonsFor(["V96"])[0];
const L = `  ── how to write it ──────────────────────────────────\n\n  [V96]\n${V96.snippet.split("\n").map((l) => `    ${l}\n`).join("")}    → agentopology docs ${V96.topic}\n\n`;
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

  it("planted: one extra or changed line inside the lesson is not removed", () => {
    const extra = L.replace("    → agentopology docs", "    planted extra line\n    → agentopology docs");
    const out = unescapedQuoteValidate(HEAD + W + extra);
    expect(out === null || out !== PASS).toBe(true);
    const changed = L.replace(V96.snippet.split("\n")[0], "# something else");
    const out2 = unescapedQuoteValidate(HEAD + W + changed);
    expect(out2 === null || out2 !== PASS).toBe(true);
  });

  it("import: only the count and Run lines are put back as the verdict; an extra line stays", () => {
    const was = "Importing\n\n  Flow unknown for: a (imported as invocation: manual)\n  Generated file passes all validation rules.\n\n";
    const now = "Importing\n\n  Flow unknown for: a (imported as invocation: manual)\n\n  0 error(s), 1 warning(s) in generated file.\n  Run agentopology validate <ROOT>/t.at for details.\n\n";
    expect(unescapedQuoteImport(now, HEAD + W + L)).toBe(was);
    expect(unescapedQuoteImport(now.replace("Importing\n", "Importing\n  planted\n"), HEAD + W + L)).not.toBe(was);
    expect(unescapedQuoteImport(now.replace("1 warning(s)", "2 warning(s)"), HEAD + W + L)).toBeNull();
  });
});

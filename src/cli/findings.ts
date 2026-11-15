/**
 * The `--json` document of `validate` and `guard --check`: the findings of the
 * language's own checks, one shape for both commands. Its schema is
 * spec/findings-output.schema.json.
 *
 * @module
 */

import type { ValidationResult } from "../parser/validator.js";
import type { GuardReport } from "../guard/check.js";
import type { MissingPointer } from "../inventory/index.js";

export type FindingSeverity = "error" | "warning" | "info";
export type FindingSource = "cli" | "parser" | "validator" | "conformance" | "coverage" | "guard";

export interface Finding {
  id: string;
  severity: FindingSeverity;
  message: string;
  file: string;
  line: number | null;
  source: FindingSource;
}

export interface FindingsDocument {
  version: 1;
  command: "validate" | "guard --check";
  target?: string;
  findings: Finding[];
  exitCode: 0 | 1;
}

/** The line a message names ("... line 12 ..."), or null. */
export function lineOf(message: string): number | null {
  const m = /\bline (\d+)/.exec(message);
  return m ? Number(m[1]) : null;
}

/** One finding per validation result; a rule id that is not V<n> or CX<n> came from a host conformance check. */
export function validationFindings(results: Array<Pick<ValidationResult, "rule" | "level" | "message" | "node" | "line">>, file: string): Finding[] {
  return results.map((r) => ({
    id: r.rule,
    severity: r.level,
    message: r.node ? `${r.message} (${r.node})` : r.message,
    file,
    line: r.line ?? null,
    source: /^(?:V|CX)\d+$/.test(r.rule) ? "validator" : "conformance",
  }));
}

/** One error per path the .at points at that is not on disk. */
export function coverageFindings(missing: MissingPointer[]): Finding[] {
  return missing.map((m) => ({
    id: "coverage.missing",
    severity: "error",
    message: `${m.path} is not on disk (named by ${m.from})`,
    file: m.path,
    line: null,
    source: "coverage",
  }));
}

/**
 * One finding per graded item: an error when it counts toward the report's
 * `missing` (the check's exit 1), else info. One info per hook the check
 * cannot tie to a step.
 */
export function guardFindings(report: GuardReport, file: string): Finding[] {
  const out: Finding[] = report.items.map((i) => {
    const failing = i.strength === "none" && !i.declared && !i.structural;
    const label = `${i.kind === "permission" ? "" : i.kind + " "}${i.id}`;
    const grade = i.gradeNote ? `${i.strength}, ${i.gradeNote}` : i.strength;
    const notes = i.notes.length ? `; ${i.notes.join("; ")}` : "";
    return {
      id: `guard.${i.kind}`,
      severity: failing ? "error" : "info",
      message: `${label}: ${grade} (by ${i.by}) ${i.where}${notes}`,
      file,
      line: null,
      source: "guard",
    };
  });
  const config = report.platform?.config ?? ".claude/settings.json";
  for (const u of report.unattributed) {
    out.push({ id: "guard.unattributed-hook", severity: "info", message: `a hook not tied to any step: ${u}`, file: config, line: null, source: "guard" });
  }
  return out;
}

/**
 * Print the document as the only thing on stdout and set the exit code to its
 * own. It does not call process.exit, so a piped stdout is never cut short:
 * the caller returns and the process ends when the write is done.
 */
export function emitFindings(doc: FindingsDocument): void {
  process.exitCode = doc.exitCode;
  process.stdout.write(`${JSON.stringify(doc, null, 2)}\n`);
}

/** One error finding from the CLI or the parser, for a run that stops before any check. */
export function stopFinding(id: string, message: string, file: string, source: FindingSource): Finding {
  return { id, severity: "error", message, file, line: lineOf(message), source };
}

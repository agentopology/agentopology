/**
 * The signed human gate (Spec C). SP-1 holds the rule call site only; the
 * rules (`instrument` and `key` on disk and in `written-by`, `record:`
 * declared, `covers` needs a record, the relayed-yes warning) arrive in SP-10.
 *
 * @module
 */

import type { TopologyAST } from "../parser/ast.js";
import type { ValidationResult } from "../parser/validator.js";

/** The human-gate rules. Empty until SP-10: it finds nothing. */
export function humanRules(_ast: TopologyAST): ValidationResult[] {
  return [];
}

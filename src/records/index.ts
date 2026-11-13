/**
 * Records (Spec B): files that only named programs may write. SP-1 holds the
 * rule call site only; the rules (`written-by` on disk, the "anyone may write
 * this record" warning, cited `guard:` hooks, the store/record same-id
 * warning) arrive in SP-6.
 *
 * @module
 */

import type { TopologyAST } from "../parser/ast.js";
import type { ValidationResult } from "../parser/validator.js";

/** The record rules. Empty until SP-6: it finds nothing. */
export function recordRules(_ast: TopologyAST): ValidationResult[] {
  return [];
}

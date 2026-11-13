/**
 * Compose (Spec A): a master file made of lane files, resolved into one
 * topology. SP-1 holds the rule call site only; the resolver and the rules
 * (`alias.node` lookup, unique ids, the outside-project error, `pin-imports`)
 * arrive in SP-2 and SP-3.
 *
 * @module
 */

import type { TopologyAST } from "../parser/ast.js";
import type { ValidationResult } from "../parser/validator.js";

/** What the compose rules need from `validate`'s options. */
export interface ComposeRuleOptions {
  /** Path of the file `ast` was parsed from, when known. */
  filePath?: string;
}

/** The compose rules. Empty until SP-2: it finds nothing. */
export function composeRules(_ast: TopologyAST, _opts: ComposeRuleOptions = {}): ValidationResult[] {
  return [];
}

/**
 * Records (Spec B): files that only named programs may write. The rules
 * (`written-by` on disk, the "anyone may write this record" warning, the
 * store/record same-id warning, cited `guard:` hooks) live in ./validate.ts
 * (SP-6).
 *
 * @module
 */

import type { TopologyAST } from "../parser/ast.js";
import type { ValidationResult } from "../parser/validator.js";
import {
  v130RecordWriters,
  v131RecordNoWriter,
  v132RecordStoreSameId,
  v133RecordGuards,
  type RecordRuleOptions,
} from "./validate.js";

export { v130RecordWriters, v131RecordNoWriter, v132RecordStoreSameId, v133RecordGuards, type RecordRuleOptions };

/**
 * The record rules, V130 to V133. `validate` spreads each one by name (the
 * spec-sync test counts rules from that spread); this is the same four for a
 * caller that wants only the record findings.
 */
export function recordRules(ast: TopologyAST, opts: RecordRuleOptions = {}): ValidationResult[] {
  return [...v130RecordWriters(ast, opts), ...v131RecordNoWriter(ast), ...v132RecordStoreSameId(ast), ...v133RecordGuards(ast)];
}

/**
 * The stub count validate and scaffold print. Not written yet.
 *
 * @module
 */

import type { TopologyAST } from "../parser/ast.js";
import type { StubKind } from "../bindings/lib/stub.js";

export interface StubEntry { kind: StubKind; path: string }
export interface StubPlan { files: number; stubs: StubEntry[]; yours: string[] }

export function plannedStubs(_ast: TopologyAST, _target: string, _root?: string): StubPlan | null {
  throw new Error("not implemented");
}

export function stubKindLine(_stubs: StubEntry[]): string {
  throw new Error("not implemented");
}

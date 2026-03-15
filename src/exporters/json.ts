/**
 * JSON exporter — dumps the TopologyAST as a JSON file for CI/tooling.
 *
 * @module
 */

import type { TopologyAST } from "../parser/ast.js";
import type { GeneratedFile } from "../bindings/types.js";
import type { Exporter } from "./types.js";

/** Strip internal parser fields (prefixed with `_`). */
function stripInternal(ast: TopologyAST): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(ast).filter(([k]) => !k.startsWith("_")),
  );
}

export const jsonExporter: Exporter = {
  name: "json",
  description: "JSON AST dump",
  extension: ".json",
  export(ast: TopologyAST): GeneratedFile[] {
    const clean = stripInternal(ast);
    const stem = ast.topology.name;
    return [
      {
        path: `${stem}.json`,
        content: JSON.stringify(clean, null, 2) + "\n",
      },
    ];
  },
};

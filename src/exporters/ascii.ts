/**
 * ASCII exporter — the terminal flow render, written to a file.
 *
 * The renderer itself lives in `../render/ascii.ts` so `agentopology plan` can
 * print it without going through the file-writing export path. This wrapper
 * makes the same output reachable as `--format ascii` with no CLI edit, since
 * `cmdExport` validates formats dynamically from the registry.
 *
 * @module
 */

import type { TopologyAST } from "../parser/ast.js";
import type { GeneratedFile } from "../bindings/types.js";
import type { Exporter } from "./types.js";
import { renderAscii } from "../render/ascii.js";

export const asciiExporter: Exporter = {
  name: "ascii",
  description: "Terminal flow graph — execution order with gates spliced in place",
  extension: ".txt",

  export(ast: TopologyAST): GeneratedFile[] {
    return [
      {
        path: `${ast.topology.name}.flow.txt`,
        content: `${renderAscii(ast)}\n`,
        category: "machine",
      },
    ];
  },
};

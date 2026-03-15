/**
 * Exporter registry — all available export formats.
 *
 * @module
 */

import type { Exporter } from "./types.js";
import { markdownExporter } from "./markdown.js";
import { mermaidExporter } from "./mermaid.js";
import { jsonExporter } from "./json.js";

export type { Exporter } from "./types.js";
export { markdownExporter } from "./markdown.js";
export { mermaidExporter } from "./mermaid.js";
export { jsonExporter } from "./json.js";

/** All registered exporters, keyed by name. */
export const exporters: Record<string, Exporter> = {
  markdown: markdownExporter,
  mermaid: mermaidExporter,
  json: jsonExporter,
};

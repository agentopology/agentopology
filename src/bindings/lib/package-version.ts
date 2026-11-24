/**
 * The version of the running agentopology package.
 *
 * @module
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

/** The version of the running package, read from its package.json; "latest" when it cannot be read. */
export function packageVersion(): string {
  try {
    const dir = path.dirname(fileURLToPath(import.meta.url));
    return JSON.parse(fs.readFileSync(path.resolve(dir, "../../../package.json"), "utf8")).version;
  } catch {
    return "latest";
  }
}

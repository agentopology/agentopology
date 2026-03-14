/**
 * Incremental scaffold system.
 *
 * Provides manifest tracking and merge logic so that `scaffold` can
 * intelligently update files on disk without destroying user edits.
 *
 * @module
 */

export * from "./types.js";
export * from "./manifest.js";
export * from "./merge.js";
export * from "./incremental.js";

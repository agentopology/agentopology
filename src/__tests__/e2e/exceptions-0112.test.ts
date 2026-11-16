/**
 * The two scaffold-side differences from 0.11.2 that 0.11.3 keeps (ruled),
 * each pinned to its exact difference, frozen from v0.11.2
 * (differential/exceptions-0112.json):
 *
 *   - S-12: a hook running the user's script inside a `file:` authored skill
 *     folder. 0.11.2 dropped the hook from settings.json silently, so a guard
 *     the user wrote was not installed; 0.11.3 keeps it.
 *   - S-13: an `environments { production { ... } }` block. 0.11.2 leaked its
 *     values into settings.json's env; 0.11.3 does not.
 *
 * Exit code and output are identical; settings.json differs by exactly that.
 */

import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
// @ts-expect-error plain JavaScript module
import { runSequence } from "./differential/merge-sequences.mjs";
// @ts-expect-error plain JavaScript module
import { EXCEPTION_SEQUENCES, S12_HOOK, S13_KEYS } from "./differential/exception-sequences.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const CLI = resolve(here, "../../../dist/cli/index.js");

interface Step { code: number | null; output: string; settings: string | null }
const frozen = JSON.parse(fs.readFileSync(join(here, "differential/exceptions-0112.json"), "utf-8")) as { sequences: Array<{ name: string; steps: Step[] }> };
const run = (i: number) => ({ was: frozen.sequences[i].steps[0], now: (runSequence(CLI, EXCEPTION_SEQUENCES[i]) as Step[])[0] });

describe("[D-exceptions-0112] the two scaffold differences from 0.11.2, and nothing else", () => {
  it("[S-12] the hook 0.11.2 dropped is installed; exit code, output and every other setting as 0.11.2", () => {
    const { was, now } = run(0);
    expect(now.code).toBe(was.code);
    expect(now.output).toBe(was.output);
    const old = JSON.parse(was.settings!);
    const cur = JSON.parse(now.settings!);
    expect(old.hooks).toBeUndefined();
    const command = S12_HOOK.replace(".claude/", '"$CLAUDE_PROJECT_DIR/.claude/').replace(".py ", '.py" ');
    expect(cur.hooks).toEqual({ PreToolUse: [{ hooks: [{ type: "command", command }], matcher: "Edit|Write" }] });
    delete cur.hooks;
    expect(cur).toEqual(old);
  }, 120_000);

  it("[S-13] the environments values 0.11.2 leaked into env are gone; exit code, output and every other setting as 0.11.2", () => {
    const { was, now } = run(1);
    expect(now.code).toBe(was.code);
    expect(now.output).toBe(was.output);
    const old = JSON.parse(was.settings!);
    const cur = JSON.parse(now.settings!);
    expect(Object.keys(old.env)).toEqual(S13_KEYS);
    expect(cur.env).toBeUndefined();
    delete old.env;
    expect(cur).toEqual(old);
  }, 120_000);
});

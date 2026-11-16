/**
 * P-1 (0.12): a hook's identity in settings.json should be its event, matcher
 * and command AND its `if`, timeout, onFailure (strength) and async.
 *
 * Present in 0.11.2: the settings.json merge keys a hook by matcher and
 * command only, so two .at hooks on one script with different `if:` lose one
 * after an edit to settings.json, and a timeout, if: or strength changed in
 * the .at never reaches settings.json. rc3 changed the identity and a
 * project-path hook then ran twice; 0.11.3 merges exactly as 0.11.2
 * (merge-differential-0112.test.ts holds it there). P-1 moves to 0.12 with a
 * design that knows which entries scaffold wrote.
 */

import { describe, it } from "vitest";

describe("P-1 (0.12): a hook's identity includes if, timeout, onFailure and async", () => {
  it.todo("two hooks on one script and matcher with different if: survive an edit to settings.json and a second scaffold");
  it.todo("a timeout, if: or strength changed in the .at replaces the topology's entry, on a topology script and on a project path, with no duplicate");
  it.todo("a user's hook and the .at's on the same script, with different if or timeout, are both kept");
});

/**
 * [CX-3] The Codex probe pack: 10 facts about Codex CLI that its docs do not
 * state, settled by live runs (`scripts/codex-probes.sh`, off unless
 * CODEX_LIVE=1). This test makes no model call. It holds the record file to its
 * shape: every probe id P1-P10 has exactly one dated record with the Codex
 * version it was measured on, an answer, and evidence free of personal data.
 */
import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const SPEC = resolve(here, "../../../spec/codex");
const JSON_PATH = resolve(SPEC, "probes.json");
const MD_PATH = resolve(SPEC, "probes.md");
const IDS = ["P1", "P2", "P3", "P4", "P5", "P6", "P7", "P8", "P9", "P10"];

interface ProbeRecord {
  id: string;
  question: string;
  answer: string;
  evidence: string;
  codex_version: string;
  date: string;
}

const load = (): ProbeRecord[] => {
  expect(fs.existsSync(JSON_PATH), `missing ${JSON_PATH}`).toBe(true);
  const data = JSON.parse(fs.readFileSync(JSON_PATH, "utf8"));
  const list = Array.isArray(data) ? data : data.probes;
  expect(Array.isArray(list), "probes.json holds a list of records").toBe(true);
  return list as ProbeRecord[];
};

describe("[CX-3] codex probe pack", () => {
  it("[CX-3] every probe id P1-P10 has exactly one record", () => {
    const ids = load().map((r) => r.id);
    for (const id of IDS) expect(ids.filter((x) => x === id), `records for ${id}`).toHaveLength(1);
    expect([...ids].sort()).toEqual([...IDS].sort());
  });

  it("[CX-3] every record is dated and names the Codex version it was measured on", () => {
    for (const r of load()) {
      expect(r.date, `${r.id} date`).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(Number.isNaN(Date.parse(r.date)), `${r.id} date parses`).toBe(false);
      expect(r.codex_version, `${r.id} codex_version`).toMatch(/^\d+\.\d+\.\d+$/);
    }
  });

  it("[CX-3] every record has a question, an answer and evidence", () => {
    for (const r of load()) {
      expect(r.question?.trim().length, `${r.id} question`).toBeGreaterThan(0);
      expect(r.answer?.trim().length, `${r.id} answer`).toBeGreaterThan(0);
      expect(r.evidence?.trim().length, `${r.id} evidence`).toBeGreaterThan(0);
    }
  });

  it("[CX-3] evidence holds no session ids, home paths or emails", () => {
    const text = fs.readFileSync(JSON_PATH, "utf8") + fs.readFileSync(MD_PATH, "utf8");
    expect(text).not.toMatch(/\/Users\/|\/home\/[a-z]/);
    expect(text).not.toMatch(/[\w.+-]+@[\w-]+\.[\w.]+/);
    expect(text).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  });

  it("[CX-3] the readable table lists every probe id", () => {
    expect(fs.existsSync(MD_PATH), `missing ${MD_PATH}`).toBe(true);
    const md = fs.readFileSync(MD_PATH, "utf8");
    for (const id of IDS) expect(md, `probes.md row for ${id}`).toMatch(new RegExp(`^\\| ${id} \\|`, "m"));
  });
});

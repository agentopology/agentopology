/**
 * [VZ3] validate and guard --check text output stays byte-identical while the
 * results get structured functions. Pinned over every example before the
 * refactor; the snapshot files live in fixtures/text-pin/.
 * AGENTOPOLOGY_CLAUDE_VERSION is fixed to VERIFIED_ON, so the version line is
 * the same on every machine.
 */
import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import { resolve, dirname, join, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "../../parser/index.js";
import { VERIFIED_ON } from "../../conformance/claude-code.js";
import { claudeCodeBinding } from "../../bindings/claude-code.js";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, "../../..");
const CLI = resolve(ROOT, "dist/cli/index.js");
const PIN = resolve(here, "fixtures/text-pin");
const files = [
  ...fs.readdirSync(join(ROOT, "examples")).filter((f) => f.endsWith(".at")).map((f) => join("examples", f)),
  "kitchen-sink.at",
  join("src/__tests__/e2e/fixtures", "compile.at"),
];

const emptyBin = fs.mkdtempSync(join(os.tmpdir(), "at-pin-bin-"));
function cli(cwd: string, ...args: string[]) {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: "utf8", env: { ...process.env, PATH: emptyBin, NO_COLOR: "1", AGENTOPOLOGY_CLAUDE_VERSION: VERIFIED_ON } });
  return `${r.stdout}${r.stderr ? "--- stderr\n" + r.stderr : ""}--- exit ${r.status}\n`;
}

describe("[VZ3] text output is pinned over examples/", () => {
  for (const f of files) {
    const id = basename(f, ".at");
    it(`[VZ3] validate ${f}`, async () => {
      await expect(cli(ROOT, "validate", f)).toMatchFileSnapshot(join(PIN, `${id}.validate.txt`));
    });
    it(`[VZ3] guard --check ${f} on an empty project and a scaffolded one`, async () => {
      const work = fs.mkdtempSync(join(os.tmpdir(), "at-pin-work-"));
      fs.mkdirSync(join(work, "empty"));
      const abs = join(ROOT, f);
      let out = cli(work, "guard", abs, "--check", "--dir", "empty").replaceAll(abs, f);
      const proj = join(work, "proj");
      for (const file of claudeCodeBinding.scaffold(parse(fs.readFileSync(abs, "utf-8")))) {
        fs.mkdirSync(dirname(join(proj, file.path)), { recursive: true });
        fs.writeFileSync(join(proj, file.path), file.content, { mode: 0o755 });
      }
      out += cli(work, "guard", abs, "--check", "--dir", "proj").replaceAll(abs, f);
      await expect(out).toMatchFileSnapshot(join(PIN, `${id}.guard.txt`));
    });
  }
});

/**
 * `validate <file> --inventory <dir>` says, per schedule job, `installed` or
 * `not installed`, by asking the job's carrier: crontab -l holding the marker
 * block (a fake `crontab` on PATH here), the plist or the timer file existing
 * under a temp HOME.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const CLI = resolve(here, "../../../dist/cli/index.js");

const SRC = `topology sched : [pipeline] {
  meta {
    version: "1.0.0"
    description: "schedule install"
  }
  orchestrator {
    model: opus
  }
  agent worker {
    description: "Does work"
    model: sonnet
    permissions: autonomous
    tools: [Read]
  }
  action intake {
    kind: inline
    description: "entry"
  }
  flow { intake -> worker }
  schedule {
    job c { agent: worker
      every: "5m" }
    job l { agent: worker
      every: "7m"
      carrier: launchd }
    job s { agent: worker
      every: "9m"
      carrier: systemd }
  }
}
`;

let dir: string;
let home: string;
let bin: string;
let tab: string;
let root: string;

beforeEach(() => {
  dir = fs.mkdtempSync(join(os.tmpdir(), "at-sched-inv-"));
  home = join(dir, "home");
  bin = join(dir, "bin");
  tab = join(dir, "fake-crontab");
  root = join(dir, "proj");
  for (const d of [home, bin, root]) fs.mkdirSync(d);
  fs.writeFileSync(
    join(bin, "crontab"),
    `#!/bin/sh\nif [ "$1" = "-l" ]; then [ -f "${tab}" ] || exit 1; cat "${tab}"; exit 0; fi\nexit 2\n`,
    { mode: 0o755 },
  );
  fs.writeFileSync(join(dir, "t.at"), SRC);
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const validate = () =>
  spawnSync("node", [CLI, "validate", join(dir, "t.at"), "--inventory", root], {
    encoding: "utf8",
    env: { PATH: `${bin}:${process.env.PATH}`, HOME: home },
  });

const line = (out: string, id: string) => out.split("\n").find((l) => new RegExp(`\\b${id}\\b.*(installed)`).test(l)) ?? "";

describe("validate --inventory reports each schedule job installed or not", () => {
  it("not installed when nothing is there", () => {
    const out = validate().stdout;
    expect(line(out, "c")).toContain("not installed");
    expect(line(out, "l")).toContain("not installed");
    expect(line(out, "s")).toContain("not installed");
  });

  it("installed when the crontab holds the marker block, the plist exists, the timer file exists", () => {
    fs.writeFileSync(tab, "# BEGIN agentopology sched\n*/5 * * * * cd '/x' && bash scripts/schedule-c.sh  # c\n# END agentopology sched\n");
    fs.mkdirSync(join(home, "Library/LaunchAgents"), { recursive: true });
    fs.writeFileSync(join(home, "Library/LaunchAgents/agentopology.sched.l.plist"), "<plist/>");
    fs.mkdirSync(join(home, ".config/systemd/user"), { recursive: true });
    fs.writeFileSync(join(home, ".config/systemd/user/agentopology-sched-s.timer"), "[Timer]\n");
    const out = validate().stdout;
    expect(line(out, "c")).not.toContain("not installed");
    expect(line(out, "c")).toContain("installed");
    expect(line(out, "l")).not.toContain("not installed");
    expect(line(out, "l")).toContain("installed");
    expect(line(out, "s")).not.toContain("not installed");
    expect(line(out, "s")).toContain("installed");
  });

  it("a crontab block that does not list the job does not count for it", () => {
    fs.writeFileSync(tab, "# BEGIN agentopology sched\n# END agentopology sched\n");
    expect(line(validate().stdout, "c")).toContain("not installed");
  });
});

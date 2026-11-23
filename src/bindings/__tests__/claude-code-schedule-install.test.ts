/**
 * A schedule installs its carrier: `every:` becomes a real cron expression,
 * `carrier:` picks cron, launchd or systemd, and a generated
 * scripts/install-schedule.sh puts each job where its carrier runs it.
 * Nothing here touches a real crontab: the script runs with a fake `crontab`
 * on PATH and HOME set to a temp folder.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import { join, dirname } from "node:path";
import { parse } from "../../parser/index.js";
import { validate } from "../../parser/validator.js";
import { claudeCodeBinding } from "../claude-code.js";

const topo = (jobs: string, machines = "") => `topology sched : [pipeline] {
  meta {
    version: "1.0.0"
    description: "schedule install"
  }
${machines}
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
${jobs}
  }
}
`;

const job = (id: string, fields: string) => `    job ${id} {\n      agent: worker\n${fields}\n    }`;

afterEach(() => vi.restoreAllMocks());

function scaffold(src: string) {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  return claudeCodeBinding.scaffold(parse(src));
}

describe("every: compiles to a cron expression", () => {
  const cronOf = (every: string) => {
    const files = scaffold(topo(job("j", `      every: "${every}"`)));
    const frag = files.find((f) => f.path === "crontab.fragment")!.content;
    return frag.split("\n").find((l) => l.includes("schedule-j.sh"));
  };
  it("minutes that divide 60, hours that divide 24, and days", () => {
    expect(cronOf("5m")).toBe("*/5 * * * * bash scripts/schedule-j.sh  # j");
    expect(cronOf("30m")).toBe("*/30 * * * * bash scripts/schedule-j.sh  # j");
    expect(cronOf("2h")).toBe("0 */2 * * * bash scripts/schedule-j.sh  # j");
    expect(cronOf("1d")).toBe("0 0 * * * bash scripts/schedule-j.sh  # j");
    expect(cronOf("3d")).toBe("0 0 */3 * * bash scripts/schedule-j.sh  # j");
  });
});

describe("[V137] an every: that cron cannot say exactly is an error", () => {
  const v137 = (jobs: string) => validate(parse(topo(jobs))).filter((r) => r.rule === "V137");
  it("names the value for 7m, 45m, 5h and 0m", () => {
    for (const every of ["7m", "45m", "5h", "0m"]) {
      const r = v137(job("j", `      every: "${every}"`));
      expect(r.length, every).toBe(1);
      expect(r[0].level).toBe("error");
      expect(r[0].message).toContain(`"${every}"`);
    }
  });
  it("passes the exact ones", () => {
    for (const every of ["1m", "5m", "15m", "1h", "6h", "1d", "2d"]) expect(v137(job("j", `      every: "${every}"`)), every).toEqual([]);
  });
  it("does not apply to a launchd or systemd job, which count seconds", () => {
    expect(v137(job("j", `      every: "7m"\n      carrier: launchd`))).toEqual([]);
    expect(v137(job("j", `      every: "7m"\n      carrier: systemd`))).toEqual([]);
  });
});

describe("[V138] launchd and systemd jobs run on an interval", () => {
  const v138 = (jobs: string) => validate(parse(topo(jobs))).filter((r) => r.rule === "V138");
  it("a cron: expression on a launchd or systemd job is an error", () => {
    for (const carrier of ["launchd", "systemd"]) {
      const r = v138(job("j", `      cron: "0 3 * * *"\n      carrier: ${carrier}`));
      expect(r.length, carrier).toBe(1);
      expect(r[0].level).toBe("error");
      expect(r[0].message).toContain("every:");
    }
  });
  it("systemd is a known carrier (no V124), and every: passes", () => {
    const rs = validate(parse(topo(job("j", `      every: "10m"\n      carrier: systemd`))));
    expect(rs.filter((r) => r.rule === "V124" || r.rule === "V138")).toEqual([]);
  });
});

describe("scripts/install-schedule.sh", () => {
  let dir: string;
  let home: string;
  let bin: string;
  let tab: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(join(os.tmpdir(), "at-sched-"));
    home = join(dir, "home");
    bin = join(dir, "bin");
    tab = join(dir, "fake-crontab");
    fs.mkdirSync(home);
    fs.mkdirSync(bin);
    fs.writeFileSync(
      join(bin, "crontab"),
      `#!/bin/sh\nif [ "$1" = "-l" ]; then [ -f "${tab}" ] || { echo "no crontab for user" >&2; exit 1; }; cat "${tab}"; exit 0; fi\nif [ "$1" = "-" ]; then cat > "${tab}"; exit 0; fi\nexit 2\n`,
      { mode: 0o755 },
    );
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  const project = (src: string) => {
    const root = join(dir, "proj");
    for (const f of scaffold(src)) {
      fs.mkdirSync(dirname(join(root, f.path)), { recursive: true });
      fs.writeFileSync(join(root, f.path), f.content, { mode: f.executable ? 0o755 : 0o644 });
    }
    return root;
  };
  const run = (root: string, ...args: string[]) =>
    spawnSync("bash", [join(root, "scripts/install-schedule.sh"), ...args], {
      encoding: "utf8",
      env: { PATH: `${bin}:${process.env.PATH}`, HOME: home, FAKE_HOSTNAME: "" },
    });

  it("is written once per topology that has schedule jobs, and not otherwise", () => {
    const files = scaffold(topo(job("j", `      every: "5m"`)));
    expect(files.filter((f) => f.path === "scripts/install-schedule.sh")).toHaveLength(1);
    const none = scaffold(topo("").replace(/schedule \{[\s\S]*?\n  \}\n/, ""));
    expect(none.find((f) => f.path === "scripts/install-schedule.sh")).toBeUndefined();
  });

  it("cron: a dry run prints what it would do and writes nothing", () => {
    const root = project(topo(job("a", `      every: "5m"`)));
    fs.writeFileSync(tab, "0 1 * * * echo mine\n");
    const r = run(root);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("dry run");
    expect(r.stdout).toContain("schedule-a.sh");
    expect(fs.readFileSync(tab, "utf8")).toBe("0 1 * * * echo mine\n");
  });

  it("cron: --apply merges between marker comments and keeps the user's own lines", () => {
    const root = project(topo(job("a", `      every: "5m"`)));
    fs.writeFileSync(tab, "0 1 * * * echo mine\n");
    const r = run(root, "--apply");
    expect(r.status).toBe(0);
    const text = fs.readFileSync(tab, "utf8");
    expect(text).toContain("0 1 * * * echo mine");
    expect(text).toMatch(/# BEGIN agentopology sched\n/);
    expect(text).toMatch(/# END agentopology sched\n/);
    expect(text).toContain(`*/5 * * * * cd '${root}' && bash scripts/schedule-a.sh`);
  });

  it("cron: running --apply again replaces only its own block", () => {
    const root = project(topo(job("a", `      every: "5m"`)));
    fs.writeFileSync(tab, "0 1 * * * echo mine\n");
    run(root, "--apply");
    run(root, "--apply");
    const text = fs.readFileSync(tab, "utf8");
    expect(text.match(/# BEGIN agentopology sched/g)).toHaveLength(1);
    expect(text.match(/schedule-a\.sh/g)).toHaveLength(1);
    expect(text).toContain("echo mine");
    // a changed schedule replaces the block's lines
    const root2 = project(topo(job("a", `      every: "10m"`)));
    run(root2, "--apply");
    const after = fs.readFileSync(tab, "utf8");
    expect(after).toContain("*/10 * * * *");
    expect(after).not.toContain("*/5 * * * *");
    expect(after).toContain("echo mine");
  });

  it("cron: works when the user has no crontab yet", () => {
    const root = project(topo(job("a", `      every: "1h"`)));
    expect(run(root, "--apply").status).toBe(0);
    expect(fs.readFileSync(tab, "utf8")).toContain("0 * * * * cd");
  });

  it("refuses with exit 1, and writes nothing, when the hostname is not the job's machine", () => {
    const src = topo(job("a", `      every: "5m"\n      machine: elsewhere-box`), "  machines {\n    machine elsewhere-box { os: linux }\n  }");
    const root = project(src);
    const r = run(root, "--apply");
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("elsewhere-box");
    expect(fs.existsSync(tab)).toBe(false);
  });

  it("runs when the hostname matches machine:", () => {
    const host = spawnSync("hostname", { encoding: "utf8" }).stdout.trim().split(".")[0];
    const src = topo(job("a", `      every: "5m"\n      machine: ${host}`), `  machines {\n    machine ${host} { os: linux }\n  }`);
    const root = project(src);
    expect(run(root, "--apply").status).toBe(0);
    expect(fs.existsSync(tab)).toBe(true);
  });

  it("launchd: --apply writes a plist with the interval, and survives: reboot sets RunAtLoad", () => {
    const root = project(topo(job("a", `      every: "7m"\n      carrier: launchd\n      survives: reboot`) + "\n" + job("b", `      every: "2h"\n      carrier: launchd`)));
    const dry = run(root);
    expect(dry.status).toBe(0);
    expect(fs.existsSync(join(home, "Library/LaunchAgents"))).toBe(false);
    expect(run(root, "--apply").status).toBe(0);
    const a = fs.readFileSync(join(home, "Library/LaunchAgents/agentopology.sched.a.plist"), "utf8");
    expect(a).toContain("<key>StartInterval</key>\n  <integer>420</integer>");
    expect(a).toMatch(/<key>RunAtLoad<\/key>\s*<true\/>/);
    expect(a).toContain(join(root, "scripts/schedule-a.sh"));
    const b = fs.readFileSync(join(home, "Library/LaunchAgents/agentopology.sched.b.plist"), "utf8");
    expect(b).toContain("<integer>7200</integer>");
    expect(b).toMatch(/<key>RunAtLoad<\/key>\s*<false\/>/);
    expect(fs.existsSync(tab)).toBe(false);
  });

  it("systemd: --apply writes a user service and timer, Persistent=true for survives: reboot", () => {
    const root = project(topo(job("a", `      every: "10m"\n      carrier: systemd\n      survives: reboot`)));
    expect(run(root).status).toBe(0);
    expect(fs.existsSync(join(home, ".config/systemd/user"))).toBe(false);
    expect(run(root, "--apply").status).toBe(0);
    const dirp = join(home, ".config/systemd/user");
    const service = fs.readFileSync(join(dirp, "agentopology-sched-a.service"), "utf8");
    const timer = fs.readFileSync(join(dirp, "agentopology-sched-a.timer"), "utf8");
    expect(service).toContain(`ExecStart=/bin/bash ${join(root, "scripts/schedule-a.sh")}`);
    expect(timer).toContain("OnUnitActiveSec=600s");
    expect(timer).toContain("Persistent=true");
  });

  it("a job on another carrier is left to it (session, cloud, calendar) and not written to the crontab", () => {
    const root = project(topo(job("a", `      every: "5m"\n      carrier: cloud`)));
    const r = run(root, "--apply");
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("cloud");
    expect(fs.existsSync(tab)).toBe(false);
  });
});

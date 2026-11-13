import { describe, it, expect, vi, afterEach } from "vitest";
import { parse } from "../../parser/index.js";
import { validate } from "../../parser/validator.js";
import { codexBinding } from "../codex.js";

const topo = (jobs: string, agentExtra = "", settings = "") => `topology t : [pipeline] {
  meta {
    version: "1.0.0"
    description: "t"
  }
${settings}
  agent worker {
    description: "Does work"
    model: gpt-5.2
    permissions: autonomous
    tools: [Read]
${agentExtra}
  }

  agent reader {
    description: "Reads"
    model: gpt-5.2
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

afterEach(() => vi.restoreAllMocks());

const scaffold = (src: string) => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const files = codexBinding.scaffold(parse(src));
  const warnings = warn.mock.calls.map((c) => String(c[0]));
  return { files, warnings };
};

describe("[CX-20] schedules that run Codex", () => {
  const job = `    job nightly {
      cron: "0 2 * * *"
      agent: reader
      carrier: cron
    }`;

  it("[CX-20] a carrier: cron job scaffolds a line that calls codex exec with an explicit --sandbox and -a never", () => {
    const { files } = scaffold(topo(job));
    const script = files.find((f) => f.path === "scripts/schedule-nightly.sh")!;
    expect(script).toBeDefined();
    expect(script.executable).toBe(true);
    const line = script.content.split("\n").find((l) => /\bcodex\b/.test(l) && !l.startsWith("#"))!;
    expect(line).toMatch(/codex .*\bexec\b/);
    expect(line).toMatch(/--sandbox (read-only|workspace-write|danger-full-access)/);
    expect(line).toMatch(/-a never/);
    expect(script.content).not.toContain("claude ");
    const cron = files.find((f) => f.path === "crontab.fragment")!;
    expect(cron.content).toContain("0 2 * * * bash scripts/schedule-nightly.sh");
  });

  it("[CX-20] a project sandbox is used as the --sandbox word", () => {
    const { files } = scaffold(topo(job, "", "  settings {\n    sandbox: workspace-write\n  }\n"));
    const script = files.find((f) => f.path === "scripts/schedule-nightly.sh")!;
    expect(script.content).toContain("--sandbox workspace-write");
  });

  it("[CX-20] a carrier: session job with survives: away is an error on this target too", () => {
    const bad = `    job nightly {
      cron: "0 2 * * *"
      agent: reader
      carrier: session
      survives: away
    }`;
    const errors = validate(parse(topo(bad)), { target: "codex" }).filter((r) => r.level === "error" && r.rule === "V125");
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain("nightly");
  });

  it("[CX-20] a writing job with no sandbox word warns that exec is read-only by default", () => {
    const writing = `    job fixer {
      cron: "0 3 * * *"
      agent: worker
      carrier: cron
    }`;
    const { files, warnings } = scaffold(topo(writing, "    writes: [\"out/report.md\"]"));
    expect(warnings.filter((w) => w.includes("exec is read-only by default") && w.includes("fixer"))).toHaveLength(1);
    expect(files.find((f) => f.path === "scripts/schedule-fixer.sh")!.content).toContain("--sandbox read-only");
    const v = validate(parse(topo(writing, "    writes: [\"out/report.md\"]")), { target: "codex" });
    expect(v.filter((r) => r.rule === "CX20")).toHaveLength(1);
  });

  it("[CX-20] a reading job and a job with a sandbox word give no such warning", () => {
    expect(scaffold(topo(job)).warnings.filter((w) => w.includes("read-only by default"))).toEqual([]);
    const writing = `    job fixer {
      cron: "0 3 * * *"
      agent: worker
      carrier: cron
    }`;
    const { warnings } = scaffold(topo(writing, "    writes: [\"out/report.md\"]", "  settings {\n    sandbox: workspace-write\n  }\n"));
    expect(warnings.filter((w) => w.includes("read-only by default"))).toEqual([]);
  });

  it("[CX-20] a carrier Codex cannot carry (cloud, launchd, calendar, session) is not turned into a cron line, and says so", () => {
    const cloud = `    job nightly {
      cron: "0 2 * * *"
      agent: reader
      carrier: cloud
    }`;
    const { files, warnings } = scaffold(topo(cloud));
    expect(files.find((f) => f.path === "scripts/schedule-nightly.sh")).toBeUndefined();
    expect(warnings.some((w) => w.includes("nightly") && w.includes("cloud"))).toBe(true);
  });

  it("[CX-20] a disabled job is commented out in the crontab", () => {
    const off = `    job nightly {
      cron: "0 2 * * *"
      agent: reader
      enabled: false
    }`;
    const cron = scaffold(topo(off)).files.find((f) => f.path === "crontab.fragment")!;
    expect(cron.content).toContain("# DISABLED: 0 2 * * * bash scripts/schedule-nightly.sh");
  });
});

/**
 * `observability { }` writes the telemetry env keys Claude Code reads
 * (https://code.claude.com/docs/en/monitoring-usage) into settings.json.
 *
 * Before 0.13.0 the block reached only skill and rules text: Claude Code
 * exported nothing. A key the user writes in `env { }` wins; prompt text and
 * tool details are logged only when `capture { }` asks for them.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { parse } from "../../parser/index.js";
import { validate } from "../../parser/validator.js";
import { bindings } from "../index.js";

function topo(observability: string, env = ""): string {
  return `
topology obs-probe : [pipeline] {
  meta {
    version: "0.1.0"
    description: "Telemetry"
  }
  agent builder {
    model: sonnet
    description: "Builds"
    invocation: manual
    prompt {
      Build.
    }
  }
${observability}
${env}
}
`;
}

const BASIC = `
  observability {
    enabled: true
    exporter: otlp
    endpoint: "http://127.0.0.1:4318"
    service: "obs-probe"
  }`;

function scaffold(src: string): { env: Record<string, string> | undefined; warnings: string[] } {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    const files = bindings["claude-code"].scaffold(parse(src));
    const settings = files.find((f) => f.path === ".claude/settings.json");
    const env = settings ? (JSON.parse(settings.content).env as Record<string, string> | undefined) : undefined;
    return { env, warnings: warn.mock.calls.map((c) => String(c[0])) };
  } finally {
    warn.mockRestore();
  }
}

const TELEMETRY_KEYS = [
  "CLAUDE_CODE_ENABLE_TELEMETRY",
  "OTEL_METRICS_EXPORTER",
  "OTEL_LOGS_EXPORTER",
  "OTEL_EXPORTER_OTLP_PROTOCOL",
  "OTEL_EXPORTER_OTLP_ENDPOINT",
  "OTEL_RESOURCE_ATTRIBUTES",
  "OTEL_LOG_USER_PROMPTS",
  "OTEL_LOG_TOOL_DETAILS",
];

afterEach(() => vi.restoreAllMocks());

describe("observability { } compiles to Claude Code's telemetry env", () => {
  it("[B7] the probe's block writes the telemetry keys into settings.json env", () => {
    const { env } = scaffold(topo(BASIC));
    expect(env).toEqual({
      CLAUDE_CODE_ENABLE_TELEMETRY: "1",
      OTEL_METRICS_EXPORTER: "otlp",
      OTEL_LOGS_EXPORTER: "otlp",
      OTEL_EXPORTER_OTLP_PROTOCOL: "http/protobuf",
      OTEL_EXPORTER_OTLP_ENDPOINT: "http://127.0.0.1:4318",
      OTEL_RESOURCE_ATTRIBUTES: "service.name=obs-probe",
    });
  });

  it("an endpoint on port 4317 (gRPC) gets protocol grpc", () => {
    const { env } = scaffold(topo(BASIC.replace("4318", "4317")));
    expect(env?.OTEL_EXPORTER_OTLP_PROTOCOL).toBe("grpc");
  });

  it("attributes follow service.name in key=value,key=value form, values percent-encoded", () => {
    const { env } = scaffold(topo(`
  observability {
    enabled: true
    exporter: otlp
    service: "obs-probe"
    attributes {
      team.id: "platform"
      cost_center: "eng-123"
      owner: "Data Team=1"
    }
  }`));
    expect(env?.OTEL_RESOURCE_ATTRIBUTES).toBe("service.name=obs-probe,team.id=platform,cost_center=eng-123,owner=Data%20Team%3D1");
  });

  it("the parser reads attributes as a key/value map, and leaves it out when absent", () => {
    const ast = parse(topo(`
  observability {
    attributes {
      team.id: "platform"
      tier: gold
    }
  }`));
    const attrs = (o: unknown) => (o as { attributes?: Record<string, string> } | null)?.attributes;
    expect(attrs(ast.observability)).toEqual({ "team.id": "platform", tier: "gold" });
    expect(attrs(parse(topo(BASIC)).observability)).toBeUndefined();
  });

  it("capture absent, or written false: neither logging key, no capture warning", () => {
    for (const capture of ["", "capture {\n      prompts: false\n      tool-args: false\n    }"]) {
      const { env, warnings } = scaffold(topo(BASIC.replace(/\n  }$/, `\n    ${capture}\n  }`)));
      // Telemetry is on, and still neither logging switch is written.
      expect(env?.CLAUDE_CODE_ENABLE_TELEMETRY).toBe("1");
      expect(env).not.toHaveProperty("OTEL_LOG_USER_PROMPTS");
      expect(env).not.toHaveProperty("OTEL_LOG_TOOL_DETAILS");
      expect(warnings.filter((w) => /client content/.test(w))).toEqual([]);
    }
  });

  it("capture prompts: true writes OTEL_LOG_USER_PROMPTS=1 and warns that prompt text can carry client content", () => {
    const { env, warnings } = scaffold(topo(BASIC.replace(/\n  }$/, "\n    capture {\n      prompts: true\n    }\n  }")));
    expect(env?.OTEL_LOG_USER_PROMPTS).toBe("1");
    expect(env).not.toHaveProperty("OTEL_LOG_TOOL_DETAILS");
    expect(warnings.some((w) => w.includes("OTEL_LOG_USER_PROMPTS") && /prompt text/.test(w) && /client content/.test(w))).toBe(true);
  });

  it("capture tool-args: true writes OTEL_LOG_TOOL_DETAILS=1 and warns that tool details can carry client content", () => {
    const { env, warnings } = scaffold(topo(BASIC.replace(/\n  }$/, "\n    capture {\n      prompts: false\n      tool-args: true\n    }\n  }")));
    expect(env?.OTEL_LOG_TOOL_DETAILS).toBe("1");
    expect(env).not.toHaveProperty("OTEL_LOG_USER_PROMPTS");
    expect(warnings.some((w) => w.includes("OTEL_LOG_TOOL_DETAILS") && /tool details/.test(w) && /client content/.test(w))).toBe(true);
  });

  it("a key in env { } wins over the mapped one, and a differing value warns with both values", () => {
    const src = topo(BASIC, `
  env {
    OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector:4318"
    OTEL_METRICS_EXPORTER: "otlp"
  }`);
    const { env, warnings } = scaffold(src);
    expect(env?.OTEL_EXPORTER_OTLP_ENDPOINT).toBe("http://collector:4318");
    const hits = warnings.filter((w) => w.includes("OTEL_EXPORTER_OTLP_ENDPOINT"));
    expect(hits).toHaveLength(1);
    expect(hits[0]).toContain("http://collector:4318");
    expect(hits[0]).toContain("http://127.0.0.1:4318");
    // Same value: no warning.
    expect(warnings.filter((w) => w.includes("OTEL_METRICS_EXPORTER"))).toEqual([]);

    const v = validate(parse(src)).filter((r) => r.rule === "V137");
    expect(v).toHaveLength(1);
    expect(v[0].level).toBe("warning");
    expect(v[0].message).toContain("OTEL_EXPORTER_OTLP_ENDPOINT");
    expect(v[0].message).toContain("http://collector:4318");
    expect(v[0].message).toContain("http://127.0.0.1:4318");
    // Only Claude Code reads these keys.
    expect(validate(parse(src), { target: "codex" }).filter((r) => r.rule === "V137")).toEqual([]);
  });

  it("a written spans { } block warns that Claude Code has no per-span setting; none written, no warning", () => {
    const withSpans = scaffold(topo(BASIC.replace(/\n  }$/, "\n    spans {\n      agents: true\n      gates: true\n    }\n  }")));
    expect(withSpans.warnings.some((w) => /spans/.test(w) && /not written/.test(w))).toBe(true);
    expect(scaffold(topo(BASIC)).warnings.filter((w) => /spans/.test(w))).toEqual([]);
  });

  it("enabled: false, or no observability block, writes no telemetry key", () => {
    for (const src of [topo(BASIC.replace("enabled: true", "enabled: false")), topo("")]) {
      const { env } = scaffold(src);
      for (const k of TELEMETRY_KEYS) expect(env ?? {}).not.toHaveProperty(k);
    }
  });

  it("the user's own env { } keys are still written next to the mapped ones", () => {
    const { env } = scaffold(topo(BASIC, `
  env {
    LOG_LEVEL: "info"
  }`));
    expect(env?.LOG_LEVEL).toBe("info");
    expect(env?.CLAUDE_CODE_ENABLE_TELEMETRY).toBe("1");
  });
});

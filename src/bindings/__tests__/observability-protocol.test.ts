/**
 * `observability { protocol: }` sets OTEL_EXPORTER_OTLP_PROTOCOL.
 *
 * https://code.claude.com/docs/en/monitoring-usage documents `grpc`,
 * `http/json` and `http/protobuf`. Without the field the value stays what it
 * was: grpc for a :4317 endpoint, http/protobuf otherwise.
 */

import { describe, it, expect, vi } from "vitest";
import { parse } from "../../parser/index.js";
import { validate } from "../../parser/validator.js";
import { bindings } from "../index.js";

function topo(obs: string): string {
  return `
topology proto-probe : [pipeline] {
  meta {
    version: "0.1.0"
    description: "Protocol"
  }
  agent builder {
    model: sonnet
    description: "Builds"
    invocation: manual
    prompt {
      Build.
    }
  }
  observability {
    exporter: otlp
    endpoint: "http://127.0.0.1:4318"
${obs}
  }
}
`;
}

function protocolOf(src: string): string | undefined {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    const files = bindings["claude-code"].scaffold(parse(src));
    const s = files.find((f) => f.path === ".claude/settings.json")!;
    return (JSON.parse(s.content).env as Record<string, string>).OTEL_EXPORTER_OTLP_PROTOCOL;
  } finally {
    warn.mockRestore();
  }
}

describe("observability protocol", () => {
  it("without the field the value is unchanged (http/protobuf)", () => {
    expect(protocolOf(topo(""))).toBe("http/protobuf");
  });
  it("without the field a :4317 endpoint still gives grpc", () => {
    expect(protocolOf(topo("").replace("4318", "4317"))).toBe("grpc");
  });
  it.each(["http/json", "http/protobuf", "grpc"])("protocol: %s is written as given", (p) => {
    expect(protocolOf(topo(`    protocol: ${p}`))).toBe(p);
  });
  it("the given protocol wins over the port guess", () => {
    expect(protocolOf(topo("    protocol: http/json").replace("4318", "4317"))).toBe("http/json");
  });
  it("a documented value validates clean", () => {
    const r = validate(parse(topo("    protocol: grpc")));
    expect(r.filter((x) => x.rule === "V158")).toEqual([]);
  });
  it("a value outside the documented set is a V158 error", () => {
    const r = validate(parse(topo("    protocol: http/xml")));
    const hit = r.find((x) => x.rule === "V158");
    expect(hit?.level).toBe("error");
    expect(hit?.message).toContain("http/xml");
  });
});

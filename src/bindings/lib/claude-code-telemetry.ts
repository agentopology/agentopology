/**
 * `observability { }` as the telemetry env Claude Code reads.
 *
 * Every key and value is from https://code.claude.com/docs/en/monitoring-usage:
 * - CLAUDE_CODE_ENABLE_TELEMETRY "Enables telemetry collection (required)": `1`
 * - OTEL_METRICS_EXPORTER / OTEL_LOGS_EXPORTER: `otlp` (among console, none)
 * - OTEL_EXPORTER_OTLP_PROTOCOL: `grpc`, `http/json`, `http/protobuf`; "For a
 *   gRPC endpoint such as `http://localhost:4317`, set this to `grpc`", the
 *   docs' 4318 endpoints are http/protobuf
 * - OTEL_EXPORTER_OTLP_ENDPOINT "OTLP collector endpoint for all signals"
 * - OTEL_RESOURCE_ATTRIBUTES "comma-separated key=value pairs", no spaces,
 *   double quotes, commas, semicolons or backslashes; other characters
 *   percent-encoded, "an `=` inside a value must be written as `%3D`"
 * - OTEL_LOG_USER_PROMPTS / OTEL_LOG_TOOL_DETAILS: `1` to enable, default off
 * - OTEL_LOG_ASSISTANT_RESPONSES: "`1` to enable, `0` to keep redacted"
 *
 * One plan serves the binding (settings.json env, scaffold warnings) and V137
 * (validate), so the two never disagree.
 */

import type { SensitiveValue, TopologyAST } from "../../parser/ast.js";

/** A mapped key the user also wrote in `env { }`, with a different value: theirs is kept. */
export interface TelemetryOverride {
  key: string;
  /** The value observability { } maps to the key. */
  mapped: string;
  /** How the env { } value reads in a message (a literal, quoted, or "a secret or reference"). */
  written: string;
}

export interface TelemetryPlan {
  /** The keys to write, the ones env { } already sets left out. */
  env: Record<string, string>;
  /** Mapped keys env { } sets to another value. */
  overrides: TelemetryOverride[];
  /** What the block asks for that has no key, or a key that writes client content. */
  notes: string[];
}

/**
 * The values https://code.claude.com/docs/en/monitoring-usage documents for
 * OTEL_EXPORTER_OTLP_PROTOCOL ("Protocol for OTLP exporter, applies to all
 * signals"): `grpc`, `http/json`, `http/protobuf`. The page also documents
 * per-signal OTEL_EXPORTER_OTLP_METRICS_PROTOCOL / _LOGS_PROTOCOL (and _TRACES_)
 * with the same three values, "overrides general setting". The binding writes
 * only the general key, which covers every signal; a per-signal key is set in
 * env { } by hand. observability { protocol: } is judged by V158.
 */
export const OTLP_PROTOCOLS: readonly string[] = ["http/json", "http/protobuf", "grpc"];

/** Percent-encode what OTEL_RESOURCE_ATTRIBUTES does not allow in a key or value. */
export function encodeResourceValue(text: string): string {
  let out = "";
  for (const byte of new TextEncoder().encode(text)) {
    const ch = String.fromCharCode(byte);
    out += byte > 0x20 && byte < 0x7f && !`",;\\=%`.includes(ch)
      ? ch
      : `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
  }
  return out;
}

/** The port of an endpoint URL, or null. */
function portOf(endpoint: string): string | null {
  const m = endpoint.match(/^[a-z][a-z0-9+.-]*:\/\/[^/:?#]+:(\d+)/i);
  return m ? m[1] : null;
}

/** An env { } value as it reads in a message, and its literal (undefined for a secret or reference). */
function envValue(val: string | SensitiveValue): { literal?: string; text: string } {
  const literal = typeof val === "string"
    ? val
    : val.secretRef || val.sensitive || val.encrypted ? undefined : val.value;
  if (literal === undefined || literal.includes("${")) return { text: "a secret or reference left to the shell" };
  return { literal, text: JSON.stringify(literal) };
}

/** The telemetry env for this topology's observability block (empty when off or absent). */
export function telemetryPlan(ast: TopologyAST): TelemetryPlan {
  const plan: TelemetryPlan = { env: {}, overrides: [], notes: [] };
  const o = ast.observability;
  if (!o || !o.enabled) return plan;

  const mapped: Record<string, string> = { CLAUDE_CODE_ENABLE_TELEMETRY: "1" };
  if (o.exporter === "otlp") {
    mapped.OTEL_METRICS_EXPORTER = "otlp";
    mapped.OTEL_LOGS_EXPORTER = "otlp";
    mapped.OTEL_EXPORTER_OTLP_PROTOCOL = o.protocol && OTLP_PROTOCOLS.includes(o.protocol)
      ? o.protocol
      : o.endpoint && portOf(o.endpoint) === "4317" ? "grpc" : "http/protobuf";
  } else {
    plan.notes.push(`observability exporter "${o.exporter}" has no Claude Code exporter (it exports otlp, console or prometheus): only CLAUDE_CODE_ENABLE_TELEMETRY is written; set OTEL_METRICS_EXPORTER in env { } by hand.`);
  }
  if (o.endpoint) mapped.OTEL_EXPORTER_OTLP_ENDPOINT = o.endpoint;

  const pairs: string[] = [];
  if (o.service !== undefined) pairs.push(`service.name=${encodeResourceValue(o.service)}`);
  for (const [k, v] of Object.entries(o.attributes ?? {})) {
    if (k === "service.name" && o.service !== undefined) continue;
    pairs.push(`${encodeResourceValue(k)}=${encodeResourceValue(v)}`);
  }
  if (pairs.length > 0) mapped.OTEL_RESOURCE_ATTRIBUTES = pairs.join(",");

  if (o.capture.prompts) {
    mapped.OTEL_LOG_USER_PROMPTS = "1";
    plan.notes.push("observability capture { prompts: true } writes OTEL_LOG_USER_PROMPTS=1: the exported prompt text can carry client content.");
  }
  // OTEL_LOG_ASSISTANT_RESPONSES "When unset, falls back to the value of
  // OTEL_LOG_USER_PROMPTS": with prompts on, an unset key would log responses
  // too, so it is written 0 unless completions is true.
  if (o.capture.completions) {
    mapped.OTEL_LOG_ASSISTANT_RESPONSES = "1";
    plan.notes.push("observability capture { completions: true } writes OTEL_LOG_ASSISTANT_RESPONSES=1: the exported assistant response text can carry client content.");
  } else if (o.capture.prompts) {
    mapped.OTEL_LOG_ASSISTANT_RESPONSES = "0";
  }
  if (o.capture.toolArgs) {
    mapped.OTEL_LOG_TOOL_DETAILS = "1";
    plan.notes.push("observability capture { tool-args: true } writes OTEL_LOG_TOOL_DETAILS=1: the exported tool details (Bash commands, tool input) can carry client content.");
  }
  if (o.capture.toolResults) plan.notes.push("observability capture { tool-results } is not written: Claude Code logs tool content only with tracing on (OTEL_LOG_TOOL_CONTENT, set in env { }).");
  if (o.spansWritten) plan.notes.push("observability spans { } is not written: Claude Code has no setting per span kind. Its beta tracing (CLAUDE_CODE_ENHANCED_TELEMETRY_BETA=1 with OTEL_TRACES_EXPORTER) is set in env { } by hand.");
  if (o.sampleRate !== 1) plan.notes.push(`observability sample-rate ${o.sampleRate} is not written: Claude Code documents no sampling setting.`);

  for (const [key, value] of Object.entries(mapped)) {
    const own = ast.env[key];
    if (own === undefined) {
      plan.env[key] = value;
      continue;
    }
    const { literal, text } = envValue(own);
    if (literal !== value) plan.overrides.push({ key, mapped: value, written: text });
  }
  return plan;
}

/** The message for one override, shared by scaffold and V137. */
export function overrideMessage(o: TelemetryOverride): string {
  return `env { } sets ${o.key} to ${o.written}, observability { } maps it to ${JSON.stringify(o.mapped)}: the env { } value wins.`;
}

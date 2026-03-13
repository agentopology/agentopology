/**
 * AgentTopology — public API.
 *
 * Re-exports the parser, validator, bindings, and all public types.
 *
 * @module
 */

export { parse } from "./parser/index.js";
export { validate } from "./parser/validator.js";
export type { ValidationResult } from "./parser/validator.js";
export { bindings } from "./bindings/index.js";
export { claudeCodeBinding } from "./bindings/claude-code.js";
export { codexBinding } from "./bindings/codex.js";
export { geminiCliBinding } from "./bindings/gemini-cli.js";
export { copilotCliBinding } from "./bindings/copilot-cli.js";
export { openClawBinding } from "./bindings/openclaw.js";

export type {
  TopologyAST,
  TopologyMeta,
  NodeDef,
  OrchestratorNode,
  ActionNode,
  AgentNode,
  GateNode,
  EdgeDef,
  DepthDef,
  DepthLevel,
  TriggerDef,
  HookDef,
  SkillDef,
  ToolBlockDef,
  MeteringDef,
  ScaleDef,
  OutputsMap,
  ScheduleJobDef,
  InterfaceDef,
} from "./parser/ast.js";

export type { BindingTarget, GeneratedFile } from "./bindings/types.js";

export { generateVisualization } from "./visualizer/index.js";

export { syncFromPlatform } from "./sync/index.js";
export type { PlatformFile } from "./sync/index.js";

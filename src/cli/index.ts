#!/usr/bin/env node
/**
 * AgenTopology CLI.
 *
 * Commands:
 *   agentopology plan <file.at>                            — interpreted-mode brief
 *   agentopology validate <file.at>                        — parse and validate
 *   agentopology fix <file.at> [--target <binding>] [--write] — grade V135 gates strength: hope
 *   agentopology scaffold <file.at> --target <binding>     — generate files
 *   agentopology scaffold <file.at> --target <binding> --dry-run — preview only
 *   agentopology sync <file.at> --target <binding> --dir <path> — sync prompts back
 *   agentopology visualize <file.at>                          — generate HTML visualization
 *   agentopology targets                                   — list bindings
 *   agentopology docs [topic]                              — language reference
 *   agentopology docs --all                                — all docs (LLM ingestion)
 *   agentopology docs --agent                              — compact write-a-.at guide
 *   agentopology docs --search <term>                      — search docs
 *
 * @module
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { execFileSync, execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parse } from "../parser/index.js";
import { resolveIncludes } from "../parser/includes.js";
import { parseRange, satisfiesRange } from "../parser/range.js";
import { PluginError, pluginReportLines, preparePluginTarget, runPluginCommand, setActivePlugins } from "../plugins/runtime.js";
import { loadPlugins, packagePluginRequests, type PluginRequest } from "../plugins/load.js";
import type { TopologyAST } from "../parser/ast.js";
import { ruleAppliesTo, validate } from "../parser/validator.js";
import { bindings } from "../bindings/index.js";
import { BindingRefusal } from "../bindings/types.js";
import { isStubContent, STUB_MARKER } from "../bindings/lib/stub.js";
import { plannedStubs, stubKindCounts, stubKindLine, stubPlanLines, stubsOf } from "../scaffold/stubs.js";
import { syncFromPlatform } from "../sync/index.js";
import type { PlatformFile } from "../sync/index.js";
import { generateVisualization } from "../visualizer/index.js";
import { collectFacts, coverageResult, validateResult } from "../visualizer/facts.js";
import { currentOpener, defaultOutputDir, pickTopology, summaryLines } from "../visualizer/command.js";
import { parseBrainVault, renderBrainHtml } from "../visualizer/brain.js";
import { exporters } from "../exporters/index.js";
import { analyze } from "../analyzer/index.js";
import { listTopics, getTopic, getAllTopics, searchTopics, getAgentGuide } from "../docs/index.js";
import { lessonsFor } from "../docs/teach.js";
import {
  flowReportLines,
  importClaudeCodeWithReport,
  importFromPlatform,
  readClaudeProject,
  readProject,
  type FlowReport,
} from "../import/index.js";
import type { ClaudeProject } from "../import/walk.js";
import { InvalidManifestError, readManifest, writeManifest, hashContent } from "../scaffold/manifest.js";
import { otherRecordLines, sameTopologyLines } from "../scaffold/other-records.js";
import { computeIncrementalPlan, executeActions, nextManifestFiles, nextManifestHooks, BODY_UNRECORDED_KEPT, NOT_OURS_KEPT, USER_EDITED_KEPT } from "../scaffold/incremental.js";
import { nextManifestFields } from "../scaffold/structure.js";
import { agentOwnedPaths, scopeErrors, scopePlan, type InvalidScope } from "../scaffold/invalid-scope.js";
import { echoFields } from "../scaffold/echo.js";
import { renderDrift, structureDrift } from "../scaffold/drift.js";
import { keptSettings } from "../scaffold/settings-kept.js";
import type { StructureSpec } from "../bindings/types.js";
import { jsonChanges } from "../scaffold/diff.js";
import type { FileAction, ScaffoldManifest } from "../scaffold/types.js";
import { InvalidSettingsJsonError, SETTINGS_KEPT_DETAIL, SETTINGS_PATH, undeclaredRuleNotice, recordNamedRules, type RuleNotice } from "../scaffold/undeclared.js";
import { renderAscii } from "../render/ascii.js";
import { buildExecutionBrief, type Autonomy } from "../plan/brief.js";
import { renderBriefMarkdown } from "../plan/render.js";
import { checkCodexGuards } from "../guard/check-codex.js";
import { hasTests, renderTestRun, runGuardTests, testedGateIds, writeTestResults } from "../guard/test-run.js";
import { checkGuards, renderGuardReport } from "../guard/check.js";
import { topLevelPermissionLines } from "../guard/top-level-permissions.js";
import { checkStep, renderStepReport, parseStepArgs } from "../step/check.js";
import { planGuardTarget, applyGuardTarget } from "../guard/target.js";
import { rulesSummary } from "../parser/rules.js";
import { verifiedOnLine, installedMark, onFailureWarnings } from "../conformance/claude-code.js";
import { routeWarnings } from "../bindings/lib/route.js";
import { CLAUDE_CODE_GUARDS, CODEX_GUARDS, guardScriptPaths, keptGuardScriptLine } from "../bindings/lib/guards.js";
import { platformConformance } from "../conformance/index.js";
import { applyV135Fixes, planV135Fixes } from "../fix/v135.js";
import { strictFailures, collectInventory, coverage, renderCoverage, renderOutside, outsideChecks, unionCoverage, type InventoryItem, type CoverageReport } from "../inventory/index.js";

// ---------------------------------------------------------------------------
// ANSI colors (no external deps)
// ---------------------------------------------------------------------------

const isColorSupported =
  process.env.NO_COLOR === undefined && process.stdout.isTTY;

const c = {
  red: (s: string) => (isColorSupported ? `\x1b[31m${s}\x1b[0m` : s),
  green: (s: string) => (isColorSupported ? `\x1b[32m${s}\x1b[0m` : s),
  yellow: (s: string) => (isColorSupported ? `\x1b[33m${s}\x1b[0m` : s),
  cyan: (s: string) => (isColorSupported ? `\x1b[36m${s}\x1b[0m` : s),
  bold: (s: string) => (isColorSupported ? `\x1b[1m${s}\x1b[0m` : s),
  dim: (s: string) => (isColorSupported ? `\x1b[2m${s}\x1b[0m` : s),
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function usage(): void {
  console.log(`
${c.bold("agentopology")} — AgenTopology CLI

${c.bold("Usage:")}
  agentopology plan <file.at> [--mode plan|execute|auto] [--brief] [--task <text>] [--root <dir>] [--log <path>]
  agentopology validate <file.at> [more.at ...] [--target <binding>] [--inventory <project-dir|inventory.json>] [--dir <project-dir>] [--user]
                       With --inventory: how many live things in the project the .at
                       accounts for (unmapped warns), and what it points at that is not
                       on disk (missing, exits 1). Folders the .at lists in
                       inventory { roots: [...] } are listed too. With several .at files
                       the per-file numbers print first, then one union number. --user
                       adds ~/.claude (counted apart) and checks the needs block.
                       With one .at and a project dir it also lists structure drift: each
                       frontmatter key where the .at and an agent, skill or command file
                       disagree (exits 3 when that is all that is wrong). --json prints
                       that report as JSON instead: { schema, file, errors, missing,
                       ownedKeys, drift: [{ path, kind, id, key, state, at, file, base }] }.
                       state "kept-narrower": a tool, server or permission key the user
                       holds narrower than the .at; scaffold keeps it (--force widens).
  agentopology fix <file.at> [--target <binding>] [--write]
                       For each V135 error (a gate meant to refuse that no generated hook
                       runs): the gate, why no hook runs it, and the fix, strength: hope,
                       with an anchor from the flow that would make it refuse when there
                       is one (a suggestion; never applied). Dry run by default: writes
                       nothing, exits 2 when there is something to fix, 0 when not.
                       --write adds only the strength: hope lines (the rest of the file
                       is kept byte for byte), then validates again: exit 0 when no V135
                       error is left, 1 when one is (a gate it cannot edit in place, or
                       one in an imported file: run fix on that file). A gate that cites
                       code (at:) is listed with V135's fix, drop run: and keep the
                       citation, for a hand edit. --write refuses --dry-run and a file
                       that is not valid UTF-8 (exit 1, nothing written).
  agentopology inventory [<project-dir>] [--at <file.at>] [--user]
                       Print the project's live things (the .claude tree, settings hooks,
                       .mcp.json servers, package.json scripts) as JSON. Writes nothing.
                       --at adds the roots that .at declares; --user adds ~/.claude.
  agentopology scaffold <file.at> --target <binding> [--dry-run] [--force] [--allow-invalid] [--prune] [--output <dir>]
  agentopology sync <file.at> --target <binding> --dir <path>
  agentopology visualize [file.at] [--dir <project>] [--output <dir>] [--no-open] [--no-check] [--print-summary]
  agentopology visualize-brain <vault-folder> [--output <dir>]
  agentopology export <file.at> --format <markdown|mermaid|json|ascii|brief> [--output <dir>]
  agentopology info <file.at>
  agentopology import --target <binding> --dir <path> [--name <topology-name>] [--output <dir>] [--force]
                       Write <name>.at into --output (default: cwd). Refuses, exit 1, when
                       that .at exists; --force overwrites it (through a symlink, too).
                       Then validates it: exit 0 when it has no errors (warnings allowed),
                       exit 2 when it has errors (the file is written), exit 1 when
                       nothing was written.
  agentopology guard <file.at> --target <claude-code|codex> [--dir <project-dir>] [--dry-run]
                       Write only the guard part of scaffold into a project that may be
                       hand-built: hook scripts, gates, checks, and the hooks and
                       permissions of settings.json (merged; for codex, .codex/hooks.json). Keeps edited scripts and
                       implemented checks, reports each. Then runs --check.
  agentopology guard <file.at> --check [--dir <project-dir>]
                       Report which gates, approval steps and permission rules the
                       project enforces today (refuse / cited / none / hope). Writes nothing;
                       exits 1 when something the binding generates is missing.
  agentopology guard <file.at> --test [--target <claude-code|codex>] [--dir <project-dir>]
                       Run the tests { refuse: [..] allow: [..] } rows of every gate and hook
                       through the real generated scripts (before-action.sh for a script step,
                       before-agent.sh for a subagent launch, a hook's own run: command), as the
                       PreToolUse payload the host sends. Scaffolds into a temp folder, or into
                       --dir (files already there are kept). Prints refused or allowed per row;
                       exits 1 on any row that is not what it was written to be.
  agentopology step check <file.at> <step-id> [--unit U] [--dir D]
                       Exit 0 when every gate before <step-id> holds (its ledger shows the
                       after: step ok for the unit; its run: exits 0 from D), else 1,
                       naming each failing gate. Call it at the start of a script step.
                       Reads and runs check scripts; never writes.
  agentopology stubs [<project-dir>]
  agentopology targets
  agentopology docs [topic]
  agentopology docs --all
  agentopology docs --agent
  agentopology docs --search <term>
  agentopology --version | -v
                       Print the agentopology version (package.json) and exit 0.

${c.bold("Commands:")}
  plan       Resolve a topology for interpreted execution: validate, apply spec
             defaults, order the flow (gates spliced by after/before), and render.
             A CLI cannot spawn agents — this prepares, the host agent enacts.
  validate   Parse an .at file and run all validation rules.
  fix        Grade the gates V135 errors on strength: hope (dry run unless --write).
  scaffold   Generate project files for a target platform.
  sync       Sync prompt content from platform files back into .at source.
  visualize  Generate an interactive HTML visualization of the topology.
             No file: the only .at in the current directory or .claude/topologies/.
             Writes to ~/.cache/agentopology/visualize/ unless --output is given.
             With --dir <project>, check results are embedded in the page.
             Auto-renders + cross-links any brain stores it declares.
  visualize-brain  Render a brain vault (folder of markdown) as an Obsidian-style
             graph. Auto-detects + links back to its owning topology if nearby.
  export     Export topology as Markdown documentation or Mermaid diagram.
  info       Analyze topology: detect patterns, compute layers, suggest improvements.
  import     Reverse-engineer platform files into an .at topology file.
  stubs      List unimplemented scaffold stubs in a scaffolded project (exits 1 if any).
  targets    List available binding targets.
  docs       Language reference — show documentation for .at syntax and features.

${c.bold("Options:")}
  --target <name>   Binding target (claude-code; codex, cursor and claude-workflow are experimental)
  --format <name>   Export format (markdown, mermaid, json, ascii, brief).
  --dir <path>      Directory to read platform files from (used with sync, import).
  --name <name>     Topology name for the generated .at file (used with import).
  --output, -o <dir> Output directory for generated files (scaffold, visualize, export, import).
  --no-open         visualize: write the page, do not open a browser.
  --no-check        visualize: do not read the project; every fact reads "not checked".
  --print-summary   visualize: print node counts and facts to stdout.
  --dry-run         Preview generated files without writing to disk.
  --write           fix: apply the edits it lists (without it, fix writes nothing).
  --force           scaffold: overwrite files scaffold did not create or that were edited (never symlinks).
                    import: overwrite the .at that is already at the output path.
  --allow-invalid   With validation errors, scaffold the agents they do not touch; shared files such as
                    settings.json and .mcp.json wait until the topology validates. Exits 1 while errors remain.
  --prune           Delete files that were previously scaffolded but are no longer generated (never .claude/settings.json).
  --mode <notch>    Autonomy for plan: plan | execute | auto (default: execute).
  --brief           Emit the machine brief only, without the terminal render.
  --task <text>     The concrete task, baked into every role prompt (plan).
  --root <dir>      Directory declared paths resolve against (plan; default: cwd).
  --log <path>      Ambiguity log path recorded in the brief (session scratchpad).
  --agent           Compact guide for writing a .at from scratch (~3 KB, not 104 KB).
  --all             Show all documentation topics (for LLM ingestion).
  --search <term>   Search across all documentation topics.
  --plugin <module> Load a compile-time plugin (repeatable; EXPERIMENTAL). Also read from
                    "agentopology": { "plugins": [...] } in the package.json of --dir,
                    else of the current folder (never of the .at's own folder).
                    A plugin is code that runs with your rights: load only plugins you trust.
  --no-plugins      Load no plugin at all, neither --plugin nor package.json. A write gate
                    reads an agentopology call on a .at as a read only with this flag.
  --help, -h        Show this help message.
`);
}

function readFile(filePath: string): string {
  const resolved = path.resolve(filePath);
  if (!fs.existsSync(resolved)) {
    console.error(c.red(`Error: file not found: ${resolved}`));
    process.exit(1);
  }
  return fs.readFileSync(resolved, "utf-8");
}

/** The version of this package, read from its package.json (next to dist/ and src/). */
function packageVersion(): string {
  try {
    const pkg = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../package.json");
    return JSON.parse(fs.readFileSync(pkg, "utf-8")).version as string;
  } catch {
    return "0.0.0";
  }
}

/**
 * `meta { requires }`: every command that reads a .at stops here, with exit 1,
 * when the running package is outside the range. The one place it is checked:
 * every reader goes through parseAt (and `step check`, which calls this).
 * An invalid range is not stopped here; validate reports it (V148).
 */
function checkRequires(ast: ReturnType<typeof parse>, filePath: string): void {
  const range = ast.topology.requires;
  if (range === undefined || !parseRange(range)) return;
  const have = packageVersion();
  if (satisfiesRange(have, range)) return;
  console.error(c.red(`Error: ${path.basename(filePath)} requires agentopology ${range} (meta { requires }), but this is ${have}. Install a version in that range and run it again.`));
  process.exit(1);
}

/** For the commands that work on the text and never go through parseAt (fix, sync): the same check; a file that does not parse is left to the command to report. */
function checkRequiresInText(source: string, filePath: string): void {
  let ast;
  try { ast = parse(source); } catch { return; }
  checkRequires(ast, filePath);
}

/**
 * Parse a topology read from `filePath`. The path is recorded on the AST
 * (non-enumerable, so exports do not carry it) so every later `validate(ast)`
 * resolves imports relative to the file, as `validate` does.
 */
function parseAt(source: string, filePath: string): ReturnType<typeof parse> {
  const ast = parse(source);
  checkRequires(ast, filePath);
  Object.defineProperty(ast, "sourcePath", { value: path.resolve(filePath), enumerable: false, writable: true, configurable: true });
  // Merge each `include`d fragment into the AST; what cannot be merged is a
  // V8 error validate reports (non-enumerable, so exports do not carry it).
  const includeErrors = resolveIncludes(ast, filePath, parse);
  if (includeErrors.length > 0) {
    Object.defineProperty(ast, "_includeErrors", { value: includeErrors, enumerable: false, writable: true, configurable: true });
  }
  return ast;
}

/** Recursively create directories and write a file. */
function writeFile(basePath: string, relativePath: string, content: string, executable?: boolean): void {
  const fullPath = path.join(basePath, relativePath);
  const dir = path.dirname(fullPath);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(fullPath, content, "utf-8");
  if (executable) fs.chmodSync(fullPath, 0o755);
}

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

interface ParsedArgs {
  command: string | undefined;
  file: string | undefined;
  target: string | undefined;
  format: string | undefined;
  dir: string | undefined;
  output: string | undefined;
  name: string | undefined;
  dryRun: boolean;
  /** `fix --write`: apply the edits. */
  write: boolean;
  force: boolean;
  allowInvalid: boolean;
  prune: boolean;
  all: boolean;
  search: string | undefined;
  agentGuide: boolean;
  mode: string | undefined;
  brief: boolean;
  log: string | undefined;
  task: string | undefined;
  root: string | undefined;
  check: boolean;
  /** `guard --test`: run the tests rows of gates and hooks through the generated scripts. */
  test: boolean;
  noOpen: boolean;
  noCheck: boolean;
  printSummary: boolean;
  inventory: string | undefined;
  /** `--user`: add the user-level tree (inventory) and check what `needs` declares (validate --inventory). */
  user: boolean;
  /** `validate --inventory <dir> --json`: the structure drift report as JSON. */
  json: boolean;
  /** `inventory --at <file.at>` (repeatable): topologies whose `inventory { roots }` are listed. */
  at: string[];
  /** More .at files after the first: `validate --inventory DIR a.at b.at`. */
  more: string[];
  /** `--plugin <module>` (repeatable): plugin modules to load (EXPERIMENTAL). */
  plugins: string[];
  /** `--no-plugins`: load no plugin, neither `--plugin` nor the package.json list. */
  noPlugins: boolean;
  help: boolean;
}

function parseArgs(argv: string[]): ParsedArgs {
  const args = argv.slice(2); // skip node and script path
  const result: ParsedArgs = {
    command: undefined,
    file: undefined,
    target: undefined,
    format: undefined,
    dir: undefined,
    output: undefined,
    name: undefined,
    dryRun: false,
    write: false,
    force: false,
    allowInvalid: false,
    prune: false,
    all: false,
    search: undefined,
    agentGuide: false,
    mode: undefined,
    brief: false,
    log: undefined,
    task: undefined,
    root: undefined,
    check: false,
    test: false,
    noOpen: false,
    noCheck: false,
    printSummary: false,
    inventory: undefined,
    user: false,
    json: false,
    at: [],
    more: [],
    plugins: [],
    noPlugins: false,
    help: false,
  };

  let i = 0;
  while (i < args.length) {
    const arg = args[i];

    if (arg === "--help" || arg === "-h") {
      result.help = true;
      i++;
      continue;
    }
    if (arg === "--dry-run") {
      result.dryRun = true;
      i++;
      continue;
    }
    if (arg === "--write") {
      result.write = true;
      i++;
      continue;
    }
    if (arg === "--allow-invalid") {
      result.allowInvalid = true;
      i++;
      continue;
    }
    if (arg === "--force") {
      result.force = true;
      i++;
      continue;
    }
    if (arg === "--prune") {
      result.prune = true;
      i++;
      continue;
    }
    if (arg === "--check") {
      result.check = true;
      i++;
      continue;
    }
    if (arg === "--test") {
      result.test = true;
      i++;
      continue;
    }
    if (arg === "--no-open") { result.noOpen = true; i++; continue; }
    if (arg === "--no-check") { result.noCheck = true; i++; continue; }
    if (arg === "--print-summary") { result.printSummary = true; i++; continue; }
    if (arg === "--inventory" && i + 1 < args.length) {
      result.inventory = args[i + 1];
      i += 2;
      continue;
    }
    if (arg === "--user") { result.user = true; i++; continue; }
    if (arg === "--json") { result.json = true; i++; continue; }
    if (arg === "--at" && i + 1 < args.length) { result.at.push(args[i + 1]); i += 2; continue; }
    if (arg === "--plugin" && i + 1 < args.length) { result.plugins.push(args[i + 1]); i += 2; continue; }
    if (arg === "--no-plugins") { result.noPlugins = true; i++; continue; }
    if (arg === "--all") {
      result.all = true;
      i++;
      continue;
    }
    if (arg === "--search" && i + 1 < args.length) {
      result.search = args[i + 1];
      i += 2;
      continue;
    }
    if (arg === "--target" && i + 1 < args.length) {
      result.target = args[i + 1];
      i += 2;
      continue;
    }
    if (arg === "--format" && i + 1 < args.length) {
      result.format = args[i + 1];
      i += 2;
      continue;
    }
    if (arg === "--dir" && i + 1 < args.length) {
      result.dir = args[i + 1];
      i += 2;
      continue;
    }
    if ((arg === "--output" || arg === "-o") && i + 1 < args.length) {
      result.output = args[i + 1];
      i += 2;
      continue;
    }
    if (arg === "--name" && i + 1 < args.length) {
      result.name = args[i + 1];
      i += 2;
      continue;
    }
    if (arg === "--mode" && i + 1 < args.length) {
      result.mode = args[i + 1];
      i += 2;
      continue;
    }
    if (arg === "--agent") {
      result.agentGuide = true;
      i++;
      continue;
    }
    if (arg === "--brief") {
      result.brief = true;
      i++;
      continue;
    }
    if (arg === "--log" && i + 1 < args.length) {
      result.log = args[i + 1];
      i += 2;
      continue;
    }
    if (arg === "--task" && i + 1 < args.length) {
      result.task = args[i + 1];
      i += 2;
      continue;
    }
    if (arg === "--root" && i + 1 < args.length) {
      result.root = args[i + 1];
      i += 2;
      continue;
    }

    // Positional arguments
    if (!result.command) {
      result.command = arg;
    } else if (!result.file) {
      result.file = arg;
    } else if (result.command === "validate" || result.command.includes(":")) {
      result.more.push(arg);
    }
    i++;
  }

  return result;
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/** The project folder structure drift is measured in: the --inventory dir, else --dir. */
function driftRoot(inventory: string | undefined, dir: string | undefined): string | null {
  if (inventory) {
    const p = path.resolve(inventory);
    if (fs.existsSync(p) && fs.statSync(p).isDirectory()) return p;
  }
  return inventory && dir ? path.resolve(dir) : null;
}

/** `validate <file.at> --inventory <dir> --json`: the report as JSON, nothing else on stdout. */
function cmdValidateJson(filePath: string, inventory: string, dir: string | undefined, user: boolean, target?: string): void {
  const name = path.basename(filePath);
  let ast;
  try {
    ast = parseAt(readFile(filePath), filePath);
  } catch (err) {
    console.log(JSON.stringify({ schema: 1, file: name, error: (err as Error).message }, null, 2));
    process.exit(1);
  }
  const checked = validateResult(ast, path.resolve(filePath), target);
  const { items, root } = loadInventory(inventory, dir, ast.inventoryRoots ?? [], user);
  const r = coverageResult(ast, items, root, user);
  const at = driftRoot(inventory, dir);
  let drift: ReturnType<typeof structureDrift>;
  try {
    drift = at ? structureDrift(ast, at, name) : { ownedKeys: 0, rows: [] };
  } catch (err) {
    if (!(err instanceof InvalidManifestError)) throw err;
    console.log(JSON.stringify({ schema: 1, file: name, error: err.message + "." }, null, 2));
    process.exit(1);
  }
  const stubTarget = target ?? "claude-code";
  const plan = plannedStubs(ast, stubTarget, dir ? path.resolve(dir) : undefined);
  const stubs = plan ? { target: stubTarget, files: plan.files, total: plan.stubs.length, byKind: stubKindCounts(plan.stubs) } : null;
  console.log(
    JSON.stringify(
      { schema: 1, file: name, errors: checked.errors, warnings: checked.warnings, missing: r.missing.length, ownedKeys: drift.ownedKeys, drift: drift.rows, stubs },
      null,
      2,
    ),
  );
  process.exit(checked.errors > 0 || r.missing.length > 0 || strictFailures(r).length > 0 ? 1 : drift.rows.length > 0 ? 3 : 0);
}

function cmdValidate(filePath: string, inventory?: string, dir?: string, user = false, more: string[] = [], target?: string, json = false): void {
  if (more.length) return cmdValidateMany([filePath, ...more], inventory, dir, user, target);
  if (json && inventory) return cmdValidateJson(filePath, inventory, dir, user, target);
  const source = readFile(filePath);

  let ast;
  try {
    ast = forTarget(parseAt(source, filePath), target);
  } catch (err) {
    if (err instanceof PluginError) throw err;
    console.error(c.red(`Parse error: ${(err as Error).message}`));
    process.exit(1);
  }

  console.log(
    c.bold(`Validating ${path.basename(filePath)} (${ast.topology.name} v${ast.topology.version})`)
  );
  console.log("");

  // E-6: --target <binding> adds that binding's warnings (CX* for codex).
  if (target && !(target in bindings)) {
    console.error(c.red(`Error: unknown target "${target}".`));
    process.exit(1);
  }
  const checked = validateResult(ast, path.resolve(filePath), target, dir ? path.resolve(dir) : undefined);
  // F-14: the Claude Code it runs against must read onFailure, or a refusing hook that cannot run lets the call through.
  // 0.13.0: a `when` edge Claude Code does not enforce is named (lib/route.ts).
  const ccExtra = !target || target === "claude-code" ? [...onFailureWarnings(ast), ...routeWarnings(ast)] : [];
  const results = [...checked.results, ...ccExtra];
  const errorCount = checked.errors;
  const warningCount = checked.warnings + ccExtra.length;
  if (!inventory && ast.needs) { for (const line of renderOutside(outsideChecks(ast, false, ""))) console.log(line); console.log(""); }
  const covered = inventory ? printCoverage(ast, inventory, dir, user) : true;
  // Structure drift: per frontmatter key, where the .at and a file disagree.
  // Exit 3 when that is all that is wrong (1 wins).
  const at = driftRoot(inventory, dir);
  let drift: ReturnType<typeof structureDrift> | null;
  try {
    drift = at ? structureDrift(ast, at, path.basename(filePath)) : null;
  } catch (err) {
    exitOnInvalidManifest(err, false);
    throw err;
  }
  const driftLines = drift ? renderDrift(drift) : [];
  if (driftLines.length > 0) {
    console.log(`  ${c.yellow(driftLines[0])}`);
    for (const line of driftLines.slice(1, -1)) console.log(`  ${line}`);
    console.log(c.dim(`  ${driftLines[driftLines.length - 1]}`));
    console.log("");
  }
  const drifted = !!drift && drift.rows.length > 0;
  printStubPlan(ast, target, dir);
  if (dir) printOtherRecords(path.resolve(dir), target ?? "claude-code", filePath, ast.topology.name, true);
  const rulesLine = rulesSummary(ast);
  if (rulesLine) { console.log(`  ${rulesLine}`); console.log(""); }

  if (results.length === 0) {
    console.log(c.green("  All validation rules passed."));
    console.log("");
    printVersionLines(target);
    if (!covered) process.exit(1);
    if (drifted) process.exit(3);
    return;
  }

  printFindings(results, errorCount, warningCount);
  printVersionLines(target);

  if (errorCount > 0 || !covered) {
    process.exit(1);
  }
  if (drifted) process.exit(3);
}

/**
 * How many of the files scaffold would write are stubs, by kind, for the
 * target given (claude-code when none is): the binding's own output, so
 * validate and scaffold cannot disagree. Changes no exit code.
 */
/**
 * Other .at files in the project: the hooks their manifests record that the
 * hooks file still holds (scaffold of this .at keeps them), and, with
 * `copies`, two .at files that declare one topology.
 */
function printOtherRecords(root: string, target: string, filePath: string, name: string, copies: boolean): void {
  const lines = [
    ...otherRecordLines(root, target, path.basename(filePath)),
    ...(copies ? sameTopologyLines(root, target, path.resolve(filePath), name) : []),
  ];
  if (lines.length === 0) return;
  for (const line of lines) console.log(`  ${c.yellow(line)}`);
  console.log("");
}

function printStubPlan(ast: TopologyAST, target: string | undefined, dir: string | undefined): void {
  const t = target ?? "claude-code";
  const plan = plannedStubs(ast, t, dir ? path.resolve(dir) : undefined);
  const lines = plan ? stubPlanLines(plan, t) : [];
  if (lines.length === 0) return;
  for (const line of lines) console.log(`  ${c.yellow(line)}`);
  console.log("");
}

function printFindings(results: ReturnType<typeof validateResult>["results"], errorCount: number, warningCount: number): void {
  for (const result of results) {
    const prefix =
      result.level === "error"
        ? c.red(`  ERROR [${result.rule}]`)
        : c.yellow(`  WARN  [${result.rule}]`);
    const linePart = result.line ? ` line ${result.line}:` : "";
    const nodePart = result.node ? c.dim(` (${result.node})`) : "";
    console.log(`${prefix}${linePart} ${result.message}${nodePart}`);
  }

  console.log("");
  console.log(
    `  ${c.red(`${errorCount} error(s)`)}, ${c.yellow(`${warningCount} warning(s)`)}`
  );
  console.log("");

  printLessons(results.map((r) => r.rule));
}

/**
 * Several .at files over one project: each is validated on its own, then with
 * --inventory the per-file coverage numbers print, then one union number (a
 * live thing is mapped when any of the files maps it).
 */
function cmdValidateMany(files: string[], inventory?: string, dir?: string, user = false, target?: string): void {
  const asts: TopologyAST[] = [];
  let failed = false;
  for (const f of files) {
    let ast: TopologyAST;
    try { ast = parseAt(readFile(f), f); } catch (err) {
      console.error(c.red(`Parse error: ${f}: ${(err as Error).message}`));
      process.exit(1);
    }
    asts.push(ast);
    console.log(c.bold(`Validating ${path.basename(f)} (${ast.topology.name} v${ast.topology.version})`));
    console.log("");
    if (!inventory && ast.needs) { for (const line of renderOutside(outsideChecks(ast, false, ""))) console.log(line); console.log(""); }
    const checked = validateResult(ast, path.resolve(f), target);
    const ccExtra = !target || target === "claude-code" ? [...onFailureWarnings(ast), ...routeWarnings(ast)] : [];
    const results = [...checked.results, ...ccExtra];
    const { errors } = checked;
    const warnings = checked.warnings + ccExtra.length;
    printStubPlan(ast, target, dir);
    const rulesLine = rulesSummary(ast);
    if (rulesLine) { console.log(`  ${rulesLine}`); console.log(""); }
    if (results.length === 0) { console.log(c.green("  All validation rules passed.")); console.log(""); }
    else printFindings(results, errors, warnings);
    if (errors > 0) failed = true;
  }
  if (inventory) {
    const { items, root } = loadInventory(inventory, dir, [...new Set(asts.flatMap((a) => a.inventoryRoots ?? []))], user);
    const reports = asts.map((a) => coverageResult(a, items, root, user));
    const pct = (r: CoverageReport) => (r.total ? Math.round((r.mapped / r.total) * 100) : 100);
    reports.forEach((r, i) => console.log(`  ${path.basename(files[i])}: coverage: ${r.mapped} of ${r.total} live things are in the .at (${pct(r)}%)`));
    const u = unionCoverage(reports);
    const lines = renderCoverage(u);
    lines[0] = lines[0].replace("coverage:", `coverage (union of ${files.length} files):`);
    for (const line of lines) console.log(`  ${line}`);
    console.log("");
    printTopLevelPermissions(root);
    if (u.missing.length || strictFailures(u).length) failed = true;
  }
  printVersionLines(target);
  if (failed) process.exit(1);
}

/**
 * The --inventory section: a directory is collected now, a file is a saved
 * inventory.json (its tags settled by the owner). Missing paths are resolved
 * against --dir, else the directory given, else the current directory.
 * Returns false when something the .at points at is missing.
 */
function loadInventory(inventory: string, dir: string | undefined, roots: string[], user: boolean): { items: InventoryItem[]; root: string } {
  const target = path.resolve(inventory);
  if (!fs.existsSync(target)) {
    console.error(c.red(`Error: --inventory ${inventory} not found.`));
    process.exit(1);
  }
  const isDir = fs.statSync(target).isDirectory();
  const root = path.resolve(dir ?? (isDir ? target : "."));
  let items: InventoryItem[];
  if (isDir) items = collectInventory(target, { roots, user });
  else {
    try { items = JSON.parse(fs.readFileSync(target, "utf-8")).items; } catch (err) {
      console.error(c.red(`Error: ${inventory} is not an inventory.json (${(err as Error).message}).`));
      process.exit(1);
    }
    if (!Array.isArray(items)) { console.error(c.red(`Error: ${inventory} has no items list.`)); process.exit(1); }
  }
  return { items, root };
}

function printCoverage(ast: TopologyAST, inventory: string, dir: string | undefined, user: boolean): boolean {
  const { items, root } = loadInventory(inventory, dir, ast.inventoryRoots ?? [], user);
  const r = coverageResult(ast, items, root, user);
  for (const line of renderCoverage(r)) console.log(`  ${line}`);
  console.log("");
  printTopLevelPermissions(root);
  return r.missing.length === 0 && strictFailures(r).length === 0;
}

/** Warn only: allow / deny / ask lists at the top level of the project's settings files, and the move. Changes no exit code. */
function printTopLevelPermissions(root: string): void {
  const lines = topLevelPermissionLines(root);
  if (lines.length === 0) return;
  for (const line of lines) console.log(`  ${c.yellow(line)}`);
  console.log("");
}

/**
 * Show the correct form for what just failed.
 *
 * The package ships 41 doc topics and 93 rules, and until now the two never
 * met — a rule said what was wrong, nothing showed what right looks like. This
 * closes that, at the moment it matters, without anyone having to know a second
 * command exists.
 *
 * Deduplicated by rule and capped, so a badly broken file cannot produce more
 * teaching than output: twelve V90 errors get the lesson once.
 */
function printLessons(rules: string[]): void {
  const lessons = lessonsFor(rules);
  if (lessons.length === 0) return;

  console.log(c.dim("  ── how to write it ──────────────────────────────────"));
  console.log("");
  for (const lesson of lessons) {
    console.log(c.dim(`  [${lesson.rule}]`));
    for (const line of lesson.snippet.split("\n")) {
      console.log(line.trim().startsWith("#") ? c.dim(`    ${line}`) : `    ${line}`);
    }
    console.log(c.dim(`    → agentopology docs ${lesson.topic}`));
    console.log("");
  }
}

/** An invalid settings file (bad JSON, or a root that is not an object): one line naming it and what is wrong, exit 1, nothing written. */
function exitOnInvalidSettings(err: unknown): void {
  if (err instanceof InvalidSettingsJsonError) {
    console.error(c.red(`Error: ${err.message}. Nothing was written.`));
    process.exit(1);
  }
}

/** A manifest scaffold cannot read: one line naming it and what is wrong, exit 1, nothing written. */
function exitOnInvalidManifest(err: unknown, writes = true): void {
  if (err instanceof InvalidManifestError) {
    console.error(c.red(`Error: ${err.message}.${writes ? " Fix or remove it by hand; nothing was written." : ""}`));
    process.exit(1);
  }
}

/** The same lines on scaffold and guard --target: each settings.json rule the .at does not declare. */
function printRuleNotice(notice: RuleNotice): void {
  for (const line of notice.lines) console.log(`  ${c.yellow(line)}`);
}

/**
 * The errors that stop scaffold and guard --target: validated for the target,
 * so V135 is judged per target, but without the Codex rows (CX*). The codex
 * binding prints those itself as warnings while it writes, and they never
 * stopped a build (0.12.4); `validate --target codex` still reports an
 * error-level one (CX8) as an error.
 */
function buildErrors(ast: TopologyAST, targetName: string) {
  return validate(ast, { target: targetName }).filter((r) => r.level === "error" && !r.rule.startsWith("CX"));
}

function cmdScaffold(filePath: string, targetName: string, dryRun: boolean, outputDir?: string, force?: boolean, prune?: boolean, allowInvalid?: boolean): void {
  const source = readFile(filePath);

  let ast;
  try {
    ast = forTarget(parseAt(source, filePath), targetName);
  } catch (err) {
    if (err instanceof PluginError) throw err;
    console.error(c.red(`Parse error: ${(err as Error).message}`));
    process.exit(1);
  }

  const binding = bindings[targetName];
  if (!binding) {
    if (REMOVED_TARGETS.includes(targetName)) {
      console.error(c.red(`Target "${targetName}" was removed in 0.10.0: Claude Code is the supported target.`));
      console.error(`Use agentopology 0.9.x for ${targetName}, or one of: ${Object.keys(bindings).join(", ")}`);
    } else {
      console.error(c.red(`Unknown target: "${targetName}"`));
      console.error(`Available targets: ${Object.keys(bindings).join(", ")}`);
    }
    process.exit(1);
  }
  if (binding.experimental) {
    console.warn(c.yellow(`  ${targetName} is experimental: not verified against the platform the way claude-code is.`));
  }

  // Never compile what does not validate: fields the validator rejects can
  // vanish silently in the output. --allow-invalid compiles the nodes the
  // errors do not touch, never the files the whole topology shares, and exits
  // 1 while errors remain. It used to be --force, which also overwrites kept
  // files: one flag, two risks. Validated for this target, as `validate
  // --target` is: a rule about another target's hooks (V135 on cursor, or
  // after the entry agent on codex) does not stop this one, nor does a Codex
  // row (CX*), which the binding prints as a warning.
  const errors = buildErrors(ast, targetName);
  let scope: InvalidScope | null = null;
  if (errors.length > 0) {
    const say = allowInvalid ? console.log : console.error;
    say(c[allowInvalid ? "yellow" : "red"](`  ${errors.length} validation error(s)${allowInvalid ? " — writing only the nodes without errors (--allow-invalid)" : ". Nothing was written."}`));
    for (const e of errors.slice(0, 5)) say(`  ${c.red(`[${e.rule}]`)}${e.line ? ` line ${e.line}:` : ""} ${e.message}`);
    if (errors.length > 5) say(c.dim(`  … and ${errors.length - 5} more`));
    if (!allowInvalid) {
      console.error(c.dim(`  Run: agentopology validate ${path.basename(filePath)} (--allow-invalid scaffolds anyway)`));
      process.exit(1);
    }
    scope = scopeErrors(ast, errors);
    if (scope.topologyLevel.length > 0) {
      // An error no node owns reaches every file: write nothing, as without the flag.
      const e = scope.topologyLevel[0];
      const why = e.node ? `names "${e.node}", which no single agent owns` : "names no node";
      console.error(c.red(`  Nothing was written: [${e.rule}] ${why}, so it reaches the whole topology.`));
      console.error(c.dim(`  Run: agentopology validate ${path.basename(filePath)}`));
      process.exit(1);
    }
    say("");
  }

  console.log(
    c.bold(`Scaffolding ${ast.topology.name} for ${binding.description}`)
  );
  console.log("");

  if (targetName === "claude-code") {
    console.log(c.dim(`  ${verifiedOnLine()}`));
    console.log("");
  } else {
    const conf = platformConformance(targetName);
    if (conf) {
      const mark = conf.installedMark();
      if (mark) console.log(c.dim(`  ${mark}`));
      console.log(c.dim(`  ${conf.verifiedOnLine()}`));
      console.log("");
    }
  }

  let files: ReturnType<typeof binding.scaffold>;
  let structure: StructureSpec[] = [];
  try {
    if (binding.scaffoldStructured) {
      ({ files, structure } = binding.scaffoldStructured(ast));
    } else {
      files = binding.scaffold(ast);
    }
  } catch (e) {
    if (e instanceof BindingRefusal) {
      console.error(c.red(`  ${e.message}`));
      process.exit(1);
    }
    throw e;
  }

  if (files.length === 0) {
    console.log(c.yellow("  No files generated."));
    return;
  }

  const basePath = outputDir ? path.resolve(outputDir) : process.cwd();

  // One plan for every run — the first one too. The first scaffold used to
  // skip it and write everything, overwriting real files (and, through a
  // symlink, files in another repository) before crashing half way.
  let manifest: ReturnType<typeof readManifest>;
  try {
    manifest = readManifest(basePath, targetName, path.basename(filePath));
  } catch (err) {
    exitOnInvalidManifest(err);
    throw err;
  }
  let actions: FileAction[];
  try {
    actions = computeIncrementalPlan(basePath, targetName, files, manifest, {
      force: !!force,
      structure,
      echo: targetName === "claude-code" ? (spec, text) => echoFields(ast, spec, text) : undefined,
      source: path.basename(filePath),
    });
  } catch (err) {
    exitOnInvalidSettings(err);
    throw err;
  }
  // --allow-invalid with errors open: every write the errors touch becomes a skip (⊘).
  let skipped: string[] = [];
  if (scope) ({ actions, skipped } = scopePlan(actions, agentOwnedPaths(ast, targetName), scope.erroredAgents, !!prune));
  const notice = undeclaredRuleNotice(basePath, files, actions, manifest);
  // settings.json values the .at states that the union-only merge keeps as
  // the file has them: one line per key, on a dry run too.
  const settingsFile = targetName === "claude-code" ? files.find((f) => f.path === SETTINGS_PATH) : undefined;
  const settingsOnDisk = settingsFile ? path.join(basePath, SETTINGS_PATH) : null;
  const keptSettingLines =
    !scope && settingsFile && settingsOnDisk && fs.existsSync(settingsOnDisk) && fs.statSync(settingsOnDisk).isFile()
      ? keptSettings(fs.readFileSync(settingsOnDisk, "utf-8"), settingsFile.content, SETTINGS_PATH).map((k) => k.line)
      : [];
  // Warn only: rules at the top level of a settings file stay where they are (the merge never moves a user's keys).
  const topLevelLines = targetName === "claude-code" ? topLevelPermissionLines(basePath) : [];
  const printKeptSettings = (): void => {
    for (const line of keptSettingLines) console.log(`  ${c.bold("!")} ${c.yellow(line)}`);
    for (const line of topLevelLines) console.log(`  ${c.yellow(line)}`);
  };

  const unsafe = actions.filter((a) => a.type === "blocked" && a.unsafe);
  if (unsafe.length > 0) {
    console.error(c.red(`  Refusing to write: ${unsafe.length} generated path(s) are not safe file names. Nothing was written.`));
    for (const a of unsafe) {
      if (a.type === "blocked") console.error(`  ${c.red("✗")} ${JSON.stringify(a.path)} — ${a.detail}`);
    }
    console.error(c.dim(`  Usually prose in a gate or hook "run". Run: agentopology validate ${path.basename(filePath)}`));
    process.exit(1);
  }

  // A hand-written file the topology points at but the project lacks: the
  // node will not load, and scaffold will not invent it.
  const authoredFiles = [
    ...ast.nodes.map((n) => n.file),
    ...(ast.skills ?? []).map((sk) => sk.file),
    ...(ast.triggers ?? []).map((t) => t.file),
  ].filter((f): f is string => !!f);
  const missing = authoredFiles.filter((f) => !fs.existsSync(path.join(basePath, f)));
  if (missing.length > 0) {
    console.log(c.yellow(`  ${missing.length} hand-written file(s) named by file: are not in ${basePath} (scaffold never writes them):`));
    for (const f of missing) console.log(`  ${c.yellow("?")} ${f}`);
    console.log("");
  }

  // 0.13.0: a guard script scaffold kept instead of regenerating is said by name: the new guards are not in it.
  const guardPlatform = targetName === "claude-code" ? CLAUDE_CODE_GUARDS : targetName === "codex" ? CODEX_GUARDS : null;
  const guardScripts = new Set(guardPlatform ? guardScriptPaths(ast, guardPlatform) : []);
  const printAction = (action: FileAction, preview: boolean): void => {
    switch (action.type) {
      case "create": console.log(`  ${c.green("+")} ${action.path}`); break;
      case "update":
        console.log(`  ${c.yellow("~")} ${action.path} (${action.detail})`);
        for (const hook of action.removedHooks ?? []) console.log(`  ${c.red("-")} removed generated hook ${hook}`);
        for (const note of action.notes ?? []) console.log(`  ${c.bold("!")} ${c.yellow(note)}`);
        break;
      case "delete":
        if (preview || prune) console.log(`  ${c.red("-")} ${action.path}${prune ? "" : " (needs --prune)"}`);
        break;
      case "unchanged":
        if (preview) console.log(`  ${c.dim("=")} ${action.path}`);
        for (const note of action.notes ?? []) console.log(`  ${c.bold("!")} ${c.yellow(note)}`);
        break;
      case "conflict":
        console.log(`  ${c.bold("!")} ${action.path} (${action.detail} — ${force ? "overwritten (--force)" : "kept"})`);
        break;
      case "blocked": console.log(`  ${c.red("⊘")} ${action.path} (${action.detail})`); break;
      case "patch":
        // One line per frontmatter key written, and per key kept as the file has it.
        for (const change of action.changes) console.log(`  ${c.yellow("~")} ${action.path}: ${change}`);
        for (const note of action.notes) console.log(`  ${c.bold("!")} ${action.path}: ${note}`);
        if (action.body) console.log(`  ${c.bold("!")} ${action.path}: ${action.body}`);
        if (preview && action.content === null && action.notes.length === 0 && !action.body) console.log(`  ${c.dim("=")} ${action.path}`);
        break;
      case "kept":
        // A file the user edited (or wrote) whose text scaffold would have
        // replaced: said on every run, so nothing is skipped silently.
        if (action.detail === USER_EDITED_KEPT || action.detail === NOT_OURS_KEPT || action.detail === BODY_UNRECORDED_KEPT) {
          console.log(`  ${c.bold("!")} ${action.path} (${action.detail})`);
          if (guardScripts.has(action.path)) console.log(`  ${c.bold("!")} ${c.yellow(keptGuardScriptLine(action.path, packageVersion()))}`);
        }
        // settings.json, kept where a delete used to be: said wherever the delete was.
        else if (preview || (prune && action.detail === SETTINGS_KEPT_DETAIL)) console.log(`  ${c.dim("=")} ${action.path} (${action.detail})`);
        // A script the user wrote: said on every run, so a kept script is seen.
        else if (action.detail === "user edited") console.log(`  ${c.dim("=")} ${action.path} (your script — kept, never overwritten)`);
        break;
    }
  };

  if (dryRun) {
    console.log(c.cyan("  Dry run — nothing is written:"));
    console.log("");
    for (const action of actions) {
      printAction(action, true);
      // A merged config file is the one to review before a write: show what changes.
      if (action.type === "update" && action.detail === "config merged") {
        const onDisk = fs.readFileSync(path.join(basePath, action.path), "utf-8");
        for (const line of jsonChanges(onDisk, action.content)) console.log(`      ${c.dim(line)}`);
      }
    }
    printKeptSettings();
    printRuleNotice(notice);
    console.log("");
    console.log(`  ${files.length} file(s) would be generated.`);
    if (scope) printOpenErrors(errors.length, skipped.length, true);
  } else {
    const result = executeActions(basePath, actions, { prune: !!prune, force: !!force });

    for (const action of actions) printAction(action, false);
    printKeptSettings();
    printRuleNotice(notice);
    console.log("");
    console.log(
      `  ${result.created} created, ${result.updated} updated, ${result.unchanged} unchanged, ` +
        `${result.conflicts} conflicts${result.blocked ? `, ${result.blocked} blocked` : ""}` +
        `${prune ? `, ${result.removed.length} deleted` : ""}`,
    );
    if (result.conflicts > 0 && !force) {
      // Never point at --force as the way through: for these files it replaces
      // the whole file, text included.
      console.log(
        c.yellow(
          `  ${result.conflicts} existing file(s) were kept as they are (marked !). Merge what you need from the ` +
            `generated version by hand; --force would replace each one whole.`,
        ),
      );
    }
    const keptFiles = actions.filter((a) => a.type === "kept" && (a.detail === USER_EDITED_KEPT || a.detail === NOT_OURS_KEPT || a.detail === BODY_UNRECORDED_KEPT)).length;
    if (keptFiles > 0) {
      console.log(
        c.yellow(
          `  ${keptFiles} file(s) kept as they are (marked !): their text is yours, and scaffold never replaces it, ` +
            `--force included. Merge what you need from the .at's version by hand, or delete a file to have it generated again.`,
        ),
      );
    }
    const keptKeys = actions.reduce((n, a) => n + (a.type === "patch" ? a.notes.length : 0), 0);
    if (keptKeys > 0) {
      console.log(
        c.yellow(
          `  ${keptKeys} frontmatter key(s) kept as the file has them (marked !). ` +
            `Edit the .at or the file to agree; --force takes the .at's value and never touches a file's text.`,
        ),
      );
    }

    // The manifest always matches the disk, even after a failed write, so the
    // next run knows exactly what scaffold owns.
    const newManifest: ScaffoldManifest = {
      source: path.basename(filePath),
      sourceHash: hashContent(source),
      target: targetName,
      generatedAt: new Date().toISOString(),
      files: nextManifestFiles(basePath, actions, files, manifest, result),
    };
    const fields = nextManifestFields(actions, structure, manifest, result.written);
    if (Object.keys(fields).length > 0) newManifest.fields = fields;
    const hookRecords = nextManifestHooks(actions, manifest, result);
    if (Object.keys(hookRecords).length > 0) newManifest.hooks = hookRecords;
    recordNamedRules(newManifest.files, notice.named);
    writeManifest(basePath, targetName, newManifest);

    if (result.failures.length > 0) {
      console.error("");
      console.error(c.red(`  ${result.failures.length} file(s) could not be written:`));
      for (const f of result.failures) console.error(`  ${c.red("✗")} ${f.path} — ${f.error}`);
      process.exit(1);
    }
    if (scope) printOpenErrors(errors.length, skipped.length, false);
  }

  // Stub summary: count and list any generated files that are unimplemented
  // stubs. We detect them by the AGENTOPOLOGY_STUB marker (see
  // src/bindings/lib/stub.ts). The summary goes to stderr so CI scripts can
  // capture it without polluting stdout. A stub path that holds the user's own
  // file (kept, never written over) is not a stub; the count is by kind, as
  // validate prints it (src/scaffold/stubs.ts).
  const { stubs: stubFiles } = stubsOf(files.filter((f) => !skipped.includes(f.path)), basePath);
  if (stubFiles.length > 0) {
    console.error("");
    console.error(
      c.yellow(
        `  ${c.bold(`${stubFiles.length}`)} stub(s) need implementation before this topology can run:`,
      ),
    );
    console.error(`    by kind: ${stubKindLine(stubFiles)}`);
    for (const f of stubFiles) {
      console.error(`    ${c.yellow("·")} ${f.path}`);
    }
    console.error(
      c.dim(`  Search for "${STUB_MARKER}" — remove that line when each script is implemented.`),
    );
  }
  console.log("");
  // Some files were written, but the topology is still invalid: CI must not read this as success.
  if (scope) process.exit(1);
}

/** The closing lines of an --allow-invalid run with errors open. */
function printOpenErrors(errorCount: number, skippedCount: number, dryRun: boolean): void {
  console.log(
    c.yellow(
      `  ${errorCount} validation error(s) open: ${skippedCount} file(s) ${dryRun ? "would not be" : "not"} written (marked ⊘), ` +
        `exit 1. Fix them and scaffold again to write the rest.`,
    ),
  );
}

function readDirRecursive(dirPath: string): PlatformFile[] {
  try {
    return readProject(requireDir(dirPath)).files;
  } catch (err) {
    console.error(c.red(`Error: ${(err as Error).message}`));
    process.exit(1);
  }
}

function requireDir(dirPath: string): string {
  const resolved = path.resolve(dirPath);
  if (!fs.existsSync(resolved)) {
    console.error(c.red(`Error: directory not found: ${resolved}`));
    process.exit(1);
  }
  return resolved;
}

function cmdSync(filePath: string, targetName: string, dirPath: string): void {
  const atSource = readFile(filePath);
  checkRequiresInText(atSource, filePath);
  const files = readDirRecursive(dirPath);

  const updated = syncFromPlatform(atSource, files, targetName);

  const resolved = path.resolve(filePath);
  fs.writeFileSync(resolved, updated, "utf-8");
  console.log(
    c.green(
      `  Updated ${path.basename(filePath)} with prompt blocks from ${targetName} files.`,
    ),
  );
}

interface VisualizeFlags { dir?: string; noOpen: boolean; noCheck: boolean; printSummary: boolean }

function cmdVisualize(fileArg: string | undefined, outputDir: string | undefined, flags: VisualizeFlags): void {
  let filePath = fileArg;
  if (!filePath) {
    const picked = pickTopology(process.cwd());
    if (picked.error || !picked.file) {
      console.error(c.red(`Error: ${picked.error}`));
      process.exit(1);
    }
    filePath = picked.file;
  }
  const source = readFile(filePath);

  let ast;
  try {
    ast = parseAt(source, filePath);
  } catch (err) {
    console.error(c.red(`Parse error: ${(err as Error).message}`));
    process.exit(1);
  }

  const resolved = path.resolve(filePath);
  const stem = path.basename(resolved, ".at");
  const outDir = outputDir ? path.resolve(outputDir) : defaultOutputDir();
  const atDir = path.dirname(resolved);
  const topoFileName = `${stem}-topology.html`;
  const outFile = path.join(outDir, topoFileName);

  try {
    fs.mkdirSync(outDir, { recursive: true });
  } catch (err) {
    console.error(c.red(`Error: Cannot create output dir "${outDir}"`));
    console.error((err as Error).message);
    process.exit(1);
  }

  // Discover and render every `type: brain` store this topology owns. A
  // topology can have multiple brains; each gets its own graph file, linked
  // back to this topology. The vault path is resolved relative to the .at file.
  const brainStores = (ast.stores ?? []).filter((s) => s.type === "brain");
  const brains: { id: string; href: string }[] = [];
  for (const store of brainStores) {
    const vaultPath = path.resolve(atDir, store.path ?? `${store.id}/`);
    if (!fs.existsSync(vaultPath) || !fs.statSync(vaultPath).isDirectory()) {
      console.log(c.yellow(`  brain "${store.id}": vault folder "${store.path ?? store.id}" not found — skipping its graph`));
      continue;
    }
    try {
      const graph = parseBrainVault(vaultPath);
      if (graph.nodes.length === 0) continue;
      const brainFileName = `${stem}-brain-${store.id}.html`;
      const brainHtml = renderBrainHtml(graph, {
        topologyHref: topoFileName, // sibling — both files land in outDir
        topologyName: ast.topology.name,
        sources: buildSourceStyles(store.sources, atDir),
      });
      fs.writeFileSync(path.join(outDir, brainFileName), brainHtml, "utf-8");
      brains.push({ id: store.id, href: brainFileName });
      const ghosts = graph.nodes.filter((n) => n.kind === "ghost").length;
      console.log(c.green(`  Brain "${store.id}" → ${brainFileName}`) + c.dim(` (${graph.nodes.length - ghosts} notes, ${ghosts} ghosts)`));
    } catch (err) {
      console.log(c.yellow(`  brain "${store.id}": ${(err as Error).message} — skipping`));
    }
  }

  // Facts are read from the project only with --dir (and not --no-check).
  const facts = collectFacts(ast, { source, filePath: resolved, dir: flags.noCheck ? undefined : flags.dir });
  const html = generateVisualization(ast, { brains, facts });

  try {
    fs.writeFileSync(outFile, html, "utf-8");
  } catch (err) {
    console.error(c.red(`Error: Cannot write "${outFile}"`));
    console.error((err as Error).message);
    process.exit(1);
  }

  console.log(c.green(`  Visualization written to ${outFile}`));
  if (brains.length) console.log(c.dim(`  ${brains.length} brain graph(s) linked from the topology header.`));

  if (flags.printSummary) for (const line of summaryLines(ast, facts)) console.log(line);

  // Try to open in the default browser (non-fatal if it fails).
  if (flags.noOpen) return;
  const opener = currentOpener();
  try {
    execFileSync(opener.cmd, [...opener.args, outFile], { stdio: "ignore" });
  } catch {
    // Non-fatal — the file was written successfully regardless.
  }
}

/** MIME types for the icon extensions we inline. */
const ICON_MIME: Record<string, string> = {
  ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp",
};

/**
 * Build the source→style map for a brain store, INLINING each icon file as a
 * data: URI so the output HTML stays self-contained. The .at only ever holds a
 * path; the bytes are read here at generate-time, never stored in the language.
 * `baseDir` is the directory icon paths are resolved against (the .at's dir).
 */
function buildSourceStyles(
  storeSources: Record<string, { color?: string; icon?: string }> | undefined,
  baseDir: string
): Record<string, { color?: string; icon?: string }> | undefined {
  if (!storeSources) return undefined;
  const out: Record<string, { color?: string; icon?: string }> = {};
  for (const [name, style] of Object.entries(storeSources)) {
    const resolved: { color?: string; icon?: string } = {};
    if (style.color) resolved.color = style.color;
    if (style.icon) {
      const iconPath = path.resolve(baseDir, style.icon);
      const ext = path.extname(iconPath).toLowerCase();
      const mime = ICON_MIME[ext];
      if (!mime) {
        console.log(c.yellow(`  source "${name}": icon "${style.icon}" has unsupported type — skipping icon`));
      } else if (!fs.existsSync(iconPath)) {
        console.log(c.yellow(`  source "${name}": icon "${style.icon}" not found — skipping icon`));
      } else {
        const b64 = fs.readFileSync(iconPath).toString("base64");
        resolved.icon = `data:${mime};base64,${b64}`;
      }
    }
    if (resolved.color || resolved.icon) out[name] = resolved;
  }
  return Object.keys(out).length ? out : undefined;
}

/**
 * Find the .at topology (if any) that owns a brain vault, for the reverse
 * cross-link. Scans the vault's directory and its parent for .at files, parses
 * each, and returns the first whose `type: brain` store path resolves to this
 * vault. Best-effort: parse failures on unrelated .at files are ignored.
 */
function findOwningTopology(vaultPath: string): {
  stem: string;
  name: string;
  atDir: string;
  sources?: Record<string, { color?: string; icon?: string }>;
} | null {
  const searchDirs = [path.dirname(vaultPath), path.dirname(path.dirname(vaultPath))];
  const seen = new Set<string>();
  for (const dir of searchDirs) {
    let entries: string[];
    try {
      entries = fs.readdirSync(dir).filter((f) => f.endsWith(".at"));
    } catch {
      continue;
    }
    for (const file of entries) {
      const full = path.resolve(dir, file);
      if (seen.has(full)) continue;
      seen.add(full);
      let ast;
      try {
        ast = parse(fs.readFileSync(full, "utf-8"));
      } catch {
        continue; // unrelated / invalid .at — skip
      }
      for (const store of ast.stores ?? []) {
        if (store.type !== "brain") continue;
        const storeVault = path.resolve(dir, store.path ?? `${store.id}/`);
        if (storeVault === vaultPath) {
          return { stem: path.basename(full, ".at"), name: ast.topology.name, atDir: dir, sources: store.sources };
        }
      }
    }
  }
  return null;
}

/**
 * Visualize a brain vault (a folder of Obsidian-format markdown) as an
 * interactive force-directed graph — an Obsidian-style graph view in a single
 * self-contained HTML file, no Obsidian install required.
 */
function cmdVisualizeBrain(vaultPath: string, outputDir?: string, noOpen = false): void {
  const resolved = path.resolve(vaultPath);
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
    console.error(c.red(`Error: "${vaultPath}" is not a directory. Point visualize-brain at a vault folder of .md files.`));
    process.exit(1);
  }

  let graph;
  try {
    graph = parseBrainVault(resolved);
  } catch (err) {
    console.error(c.red(`Error reading vault: ${(err as Error).message}`));
    process.exit(1);
  }

  if (graph.nodes.length === 0) {
    console.error(c.yellow(`No .md files found under "${vaultPath}". Nothing to visualize.`));
    process.exit(1);
  }

  const vaultName = path.basename(resolved) || "brain";
  const outDir = outputDir ? path.resolve(outputDir) : resolved;

  // Auto-detect the owning topology: scan nearby .at files for a `type: brain`
  // store whose path resolves to THIS vault. If found, render a "← Topology"
  // back-link pointing at where its topology visualization would live.
  const owner = findOwningTopology(resolved);
  const renderOpts = owner
    ? {
        topologyHref: `${owner.stem}-topology.html`,
        topologyName: owner.name,
        sources: buildSourceStyles(owner.sources, owner.atDir),
      }
    : {};

  const html = renderBrainHtml(graph, renderOpts);
  const outFile = path.join(outDir, `${vaultName}-graph.html`);

  try {
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(outFile, html, "utf-8");
  } catch (err) {
    console.error(c.red(`Error: Cannot write "${outFile}"`));
    console.error((err as Error).message);
    process.exit(1);
  }

  const ghosts = graph.nodes.filter((n) => n.kind === "ghost").length;
  const real = graph.nodes.length - ghosts;
  console.log(c.green(`  Brain graph written to ${outFile}`));
  console.log(c.dim(`  ${real} notes · ${graph.edges.length} links · ${ghosts} ghost nodes · ${graph.tags.length} tags`));

  if (noOpen) return;
  const opener = currentOpener();
  try {
    execFileSync(opener.cmd, [...opener.args, outFile], { stdio: "ignore" });
  } catch {
    // Non-fatal.
  }
}

function cmdExport(filePath: string, formatName: string, outputDir?: string): void {
  const source = readFile(filePath);

  let ast;
  try {
    ast = parseAt(source, filePath);
  } catch (err) {
    console.error(c.red(`Parse error: ${(err as Error).message}`));
    process.exit(1);
  }

  const exporter = exporters[formatName];
  if (!exporter) {
    console.error(c.red(`Unknown format: "${formatName}"`));
    console.error(`Available formats: ${Object.keys(exporters).join(", ")}`);
    process.exit(1);
  }

  console.log(
    c.bold(`Exporting ${ast.topology.name} as ${exporter.description}`)
  );
  console.log("");

  const files = exporter.export(ast);
  const resolved = path.resolve(filePath);
  const basePath = outputDir ? path.resolve(outputDir) : path.dirname(resolved);

  for (const file of files) {
    writeFile(basePath, file.path, file.content);
    console.log(`  ${c.green("+")} ${file.path}`);
  }
  console.log("");
  console.log(`  ${c.bold(`${files.length}`)} file(s) written to ${basePath}`);
  console.log("");
}

/**
 * `agentopology plan <file.at>` — resolve a topology for interpreted execution.
 *
 * A CLI cannot spawn subagents, so this does not run anything. It is a linter
 * and an orderer: validate, apply the spec's defaults, resolve execution order
 * (gates spliced by after/before rather than left at Kahn's depth 0), render
 * the flow for a human, and emit the brief a host coding agent enacts.
 */
function cmdPlan(
  filePath: string,
  mode: string | undefined,
  briefOnly: boolean,
  logPath: string | undefined,
  task: string | undefined,
  rootDir: string | undefined
): void {
  const source = readFile(filePath);

  let ast;
  try {
    ast = parseAt(source, filePath);
  } catch (err) {
    console.error(c.red(`Parse error: ${(err as Error).message}`));
    process.exit(1);
  }

  const notch = (mode ?? "execute") as Autonomy;
  if (!["plan", "execute", "auto"].includes(notch)) {
    console.error(c.red(`Unknown --mode "${mode}". Expected: plan, execute, auto.`));
    process.exit(1);
  }

  // Interpreted mode: the executing agent places each gate and runs it, so a
  // rule about generated hooks (V135) does not hold the plan back.
  const results = validate(ast).filter((r) => ruleAppliesTo(r, "interpreted"));
  const errors = results.filter((r) => r.level === "error");

  // Record the source-tree revision so mid-run drift is detectable. Best
  // effort: not every project is a git repo, and that is not an error.
  let revision: string | null = null;
  try {
    revision = execSync("git rev-parse --short HEAD", {
      cwd: rootDir ?? process.cwd(),
      stdio: ["ignore", "pipe", "ignore"],
      encoding: "utf8",
    }).trim();
  } catch {
    revision = null;
  }

  const brief = buildExecutionBrief(ast, {
    source: filePath,
    root: rootDir,
    task: task ?? null,
    revision,
    autonomy: notch,
    ambiguityLog: logPath ?? null,
    errors: errors.map((e) => ({ rule: e.rule, message: e.message, node: e.node })),
  });

  if (!briefOnly) {
    console.log("");
    console.log(renderAscii(ast));
    console.log("");

    if (errors.length > 0) {
      console.error(c.red(`  ${errors.length} validation error(s) — this topology cannot be enacted.`));
      for (const e of errors) {
        console.error(c.red(`    [${e.rule}] ${e.node ? e.node + ": " : ""}${e.message}`));
      }
      console.log("");
      printLessons(errors.map((e) => e.rule));
      process.exit(1);
    }

    // Surface the things the host would otherwise discover mid-run.
    const missingInputs = brief.preconditions.filter((p) => !p.exists);
    if (missingInputs.length > 0) {
      console.log(
        c.red(`  ⛔  ${missingInputs.length} run input(s) declared but missing on disk:`)
      );
      for (const m of missingInputs) console.log(c.dim(`       ${m.absolute}`));
      console.log("");
    }
    if (brief.unenforceable.length > 0) {
      const nodes = [...new Set(brief.unenforceable.map((u) => u.node))];
      console.log(
        c.yellow(
          `  ⚠  ${nodes.length} role(s) declare tool or MCP restrictions that cannot be set inline — running unrestricted:`
        )
      );
      for (const u of brief.unenforceable) {
        console.log(c.dim(`       ${u.node}: ${u.field} ${JSON.stringify(u.declared)}`));
      }
      console.log("");
    }
    if (brief.persistent.length > 0) {
      const parts = brief.persistent.map((p) => `${p.count} ${p.feature}`);
      console.log(
        c.yellow(`  ⛔  ${parts.join(", ")} declared — these need \`agentopology scaffold\`.`)
      );
      console.log("");
    }
    if (brief.preflagged.length > 0) {
      console.log(c.dim(`  ${brief.preflagged.length} ambiguity/ies pre-flagged in the brief (§10).`));
      console.log("");
    }

    console.log(c.dim("  ── brief below; everything past this line is for the agent ──"));
    console.log("");
  } else if (errors.length > 0) {
    // --brief still emits, but the document itself refuses to be enacted.
    console.log(renderBriefMarkdown(brief));
    process.exit(1);
  }

  console.log(renderBriefMarkdown(brief));
  console.log("");
}

function cmdInfo(filePath: string): void {
  const source = readFile(filePath);

  let ast;
  try {
    ast = parseAt(source, filePath);
  } catch (err) {
    console.error(c.red(`Parse error: ${(err as Error).message}`));
    process.exit(1);
  }

  const result = analyze(ast);
  const { summary, patterns, layers, suggestions } = result;

  // Summary
  console.log(
    c.bold(`Topology: ${summary.name} v${summary.version}`)
  );
  if (summary.description) {
    console.log(c.dim(`  ${summary.description}`));
  }
  console.log("");

  const counts = summary.nodeCount;
  const parts: string[] = [];
  if (counts.agents) parts.push(`${counts.agents} agent${counts.agents !== 1 ? "s" : ""}`);
  if (counts.actions) parts.push(`${counts.actions} action${counts.actions !== 1 ? "s" : ""}`);
  if (counts.gates) parts.push(`${counts.gates} gate${counts.gates !== 1 ? "s" : ""}`);
  if (counts.groups) parts.push(`${counts.groups} group${counts.groups !== 1 ? "s" : ""}`);
  if (counts.humans) parts.push(`${counts.humans} human${counts.humans !== 1 ? "s" : ""}`);
  if (counts.orchestrators) parts.push(`${counts.orchestrators} orchestrator${counts.orchestrators !== 1 ? "s" : ""}`);
  console.log(`  ${parts.join(", ")}`);

  const condEdges = ast.edges.filter((e) => e.condition).length;
  const loopEdges = ast.edges.filter((e) => e.maxIterations).length;
  const edgeParts = [`${summary.edgeCount} edge${summary.edgeCount !== 1 ? "s" : ""}`];
  if (condEdges) edgeParts.push(`${condEdges} conditional`);
  if (loopEdges) edgeParts.push(`${loopEdges} loop${loopEdges !== 1 ? "s" : ""}`);
  console.log(`  ${edgeParts.join(", ")}`);

  if (summary.declaredPatterns.length > 0) {
    console.log(`  Declared patterns: ${summary.declaredPatterns.join(", ")}`);
  }
  console.log("");

  // Detected patterns
  if (patterns.length > 0) {
    console.log(c.bold("Detected Patterns:"));
    for (const p of patterns) {
      const conf = p.confidence === "definite" ? "" : c.dim(" (likely)");
      console.log(`  ${c.cyan(p.name)}${conf}`);
      console.log(`    ${c.dim(p.description)}`);
    }
    console.log("");
  }

  // Layers
  if (layers.length > 0) {
    console.log(c.bold("Layers:"));
    for (const layer of layers) {
      const label = layer.depth === -1 ? "?" : String(layer.depth);
      console.log(`  ${c.dim(label + ":")} ${layer.nodes.join(", ")}`);
    }
    console.log("");
  }

  // Suggestions
  if (suggestions.length > 0) {
    console.log(c.bold("Suggestions:"));
    for (const s of suggestions) {
      const prefix =
        s.level === "warning"
          ? c.yellow("[warning]")
          : s.level === "improvement"
            ? c.yellow("[improvement]")
            : c.dim("[info]");
      const nodePart = s.node ? ` ${c.cyan(s.node)}:` : "";
      // Multi-line messages: indent continuation lines
      const lines = s.message.split("\n");
      console.log(`  ${prefix}${nodePart} ${lines[0]}`);
      for (const line of lines.slice(1)) {
        console.log(`    ${line}`);
      }
    }
    console.log("");
  }
}

function cmdImport(targetName: string, dirPath: string, topologyName?: string, outputDir?: string, force = false): void {
  const resolved = requireDir(dirPath);
  const name = topologyName ?? path.basename(resolved).replace(/^\./, "");

  // The .at is the only file import writes. One already there may hold the
  // user's edits, so it is replaced only with --force (S-67). lstat, so a
  // link at that path counts as there even when it points nowhere. Checked
  // first, so a refusal is the only line printed (F4); the write itself is an
  // exclusive create, so of two imports racing for one path one writes (F3).
  const outDir = outputDir ? path.resolve(outputDir) : process.cwd();
  const outFile = path.join(outDir, `${name}.at`);
  const refuse = (message: string): never => {
    console.error(c.red(`Error: ${message} Nothing was written.`));
    process.exit(1);
  };
  const exists = `${outFile} exists; pass --force to overwrite.`;
  const isDir = `${outFile} is a directory, not a .at file.`;
  const notDir = `--output ${outDir} is not a directory.`;
  // J(3): a folder on the way that cannot be read, or the one import writes in
  // that cannot be written (EACCES, EPERM), is one line, not a stack.
  const noAccess = `cannot write to --output ${outDir}: permission denied.`;
  const denied = (err: unknown) => ["EACCES", "EPERM"].includes((err as NodeJS.ErrnoException).code ?? "");
  try {
    for (let dir = outDir; ; dir = path.dirname(dir)) {
      const st = fs.statSync(dir, { throwIfNoEntry: false });
      if (st) {
        if (!st.isDirectory()) refuse(notDir);
        fs.accessSync(dir, fs.constants.W_OK | fs.constants.X_OK);
        break;
      }
      if (path.dirname(dir) === dir) break;
    }
    const atStat = fs.lstatSync(outFile, { throwIfNoEntry: false });
    if (atStat?.isDirectory() || (atStat?.isSymbolicLink() && fs.statSync(outFile, { throwIfNoEntry: false })?.isDirectory())) refuse(isDir);
    if (atStat && !force) refuse(exists);
  } catch (err) {
    if (denied(err)) refuse(noAccess);
    if ((err as NodeJS.ErrnoException).code === "ENOTDIR") refuse(notDir);
    throw err;
  }

  // First, before any read: a run that fails must still have said something.
  console.log(
    c.bold(`Importing from ${targetName} files in ${dirPath}`)
  );
  console.log("");

  let project: ReturnType<typeof readClaudeProject> = null;
  let read: Pick<ClaudeProject, "files" | "unread">;
  try {
    project = targetName === "claude-code" ? readClaudeProject(resolved) : null;
    read = project ?? readProject(resolved);
  } catch (err) {
    console.error(c.red(`Import error: ${(err as Error).message}`));
    process.exit(1);
  }
  const files = read.files;

  let atSource: string;
  let flow: FlowReport | undefined;
  try {
    if (targetName === "claude-code") {
      ({ source: atSource, report: flow } = importClaudeCodeWithReport(files, name));
    } else {
      atSource = importFromPlatform(files, targetName, name);
    }
  } catch (err) {
    console.error(c.red(`Import error: ${(err as Error).message}`));
    process.exit(1);
  }

  try {
    fs.mkdirSync(outDir, { recursive: true });
    // --force writes through a link at outFile, as 0.11.2 did.
    fs.writeFileSync(outFile, atSource, { encoding: "utf-8", flag: force ? "w" : "wx" });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EEXIST" && !force) refuse(exists);
    if (code === "EISDIR") refuse(isDir);
    if (code === "ENOTDIR" || code === "EEXIST") refuse(notDir);
    // A read-only .at with --force is the file's own permission, not the folder's.
    if (denied(err)) refuse(fs.existsSync(outFile) ? `cannot write ${outFile}: permission denied.` : noAccess);
    refuse(`cannot write ${outFile}: ${(err as Error).message}.`);
  }
  console.log(c.green(`  Written: ${outFile}`));
  if (flow) {
    console.log("");
    for (const line of flowReportLines(flow)) console.log(`  ${line}`);
  }
  for (const u of read.unread) console.log(`  ${c.yellow(`Not read: ${u.path} (${u.reason})`)}`);
  for (const nested of project?.nestedConfigs ?? []) {
    console.log(`  ${c.dim(`Not read: ${nested} (a .claude folder below the root; run import there for it)`)}`);
  }

  // Validate the written file as `validate <outFile>` does (same parse, same
  // rules, imports resolved from the file), so the counts match. The file is
  // written either way; errors exit 2, not 1, because this is not a refusal
  // (S-68). Warnings alone exit 0.
  let errorCount: number;
  // B: a hook scaffold would not compile faithfully is an import error (the .at is written).
  const unfaithful = flow?.errors ?? [];
  try {
    const checked = validateResult(parseAt(atSource, outFile), outFile);
    errorCount = checked.errors;
    if (checked.errors > 0 || checked.warnings > 0) {
      console.log("");
      console.log(`  ${c.yellow(`${checked.errors} error(s), ${checked.warnings} warning(s) in generated file.`)}`);
      console.log(`  ${c.dim("Run")} agentopology validate ${outFile} ${c.dim("for details.")}`);
    } else if (unfaithful.length > 0) {
      // P2-1: one verdict; never "passes all validation rules" with a flagged hook.
      console.log(`  ${c.yellow(`Generated .at passes validation, but ${unfaithful.length} hook(s) can't be compiled faithfully (exit 2)`)}`);
    } else {
      console.log(`  ${c.green("Generated file passes all validation rules.")}`);
    }
  } catch (err) {
    // validate reports a file that does not parse as one error, and so does import.
    console.log(`  ${c.yellow(`Parse error in generated file: ${(err as Error).message}`)}`);
    errorCount = 1;
  }
  // P2-2: each flagged hook, then its command exactly as the harness wrote it.
  for (const e of unfaithful) {
    console.log(`  ${c.red("ERROR")} ${e.message}`);
    console.log(`    ${e.command}`);
  }
  console.log("");
  if (errorCount > 0) {
    console.error(c.red(`import: the .at it wrote has ${errorCount} validation error(s); fix them, or run validate ${outFile} for details`));
  }
  if (unfaithful.length > 0) {
    console.error(c.red(`import: ${unfaithful.length} hook(s) can't be compiled faithfully; keep them as hand-written hooks or rewrite them as topology scripts`));
  }
  if (errorCount > 0 || unfaithful.length > 0) process.exit(2);
}

/** Targets removed in 0.10.0, named so the error says so instead of "unknown". */
const REMOVED_TARGETS = ["gemini-cli", "copilot-cli", "openclaw", "kiro"];

function cmdTargets(): void {
  console.log(c.bold("Available binding targets:"));
  console.log("");
  for (const [name, binding] of Object.entries(bindings)) {
    const label = binding.experimental ? c.yellow(" (experimental)") : "";
    const conf = platformConformance(name);
    const mark = name !== "claude-code" ? conf?.installedMark() : null;
    const verified = conf ? c.dim(` — ${conf.verifiedOnLine()}${mark ? `; ${mark}` : ""}`) : "";
    console.log(`  ${c.cyan(name.padEnd(16))} ${binding.description}${label}${verified}`);
  }
  console.log("");
}

/** What the installed Claude Code is, when it is not the version the output was checked against. */
function printInstalledMark(): void {
  const mark = installedMark();
  if (mark) console.log(c.dim(mark));
}

/**
 * The installed mark and the "checked against" line for the target validate
 * was run for (F-27): Claude Code when none is named, the target's own line
 * otherwise, and nothing for a target with no conformance facts.
 */
function printVersionLines(target?: string): void {
  if (!target || target === "claude-code") {
    printInstalledMark();
    console.log(c.dim(verifiedOnLine()));
    return;
  }
  const conf = platformConformance(target);
  if (!conf) return;
  const mark = conf.installedMark();
  if (mark) console.log(c.dim(mark));
  console.log(c.dim(conf.verifiedOnLine()));
}

/**
 * Scan a scaffolded project directory for unimplemented stub scripts.
 *
 * A "stub" is a file that contains the AGENTOPOLOGY_STUB marker (emitted by
 * shellStub in src/bindings/lib/stub.ts). The marker is a comment line, so
 * removing it (after implementing the script) flips the file out of stub
 * state. Designed for CI: exits 1 if stubs remain, 0 if clean.
 */
function cmdGuardCheck(filePath: string, dirPath: string, targetName?: string): void {
  const source = fs.readFileSync(path.resolve(filePath), "utf-8");
  const parsed = parseAt(source, filePath);
  const root = path.resolve(dirPath);
  // E-5: a Codex project is graded from .codex/; with no --target, a project with .codex/ and no .claude/ is one.
  const target = targetName ?? (!fs.existsSync(path.join(root, ".claude")) && fs.existsSync(path.join(root, ".codex")) ? "codex" : "claude-code");
  if (target !== "claude-code" && target !== "codex") {
    console.error(c.red(`Error: guard --check supports claude-code and codex only (got "${target}").`));
    process.exit(1);
  }
  const ast = forTarget(parsed, target);
  const report = target === "codex" ? checkCodexGuards(ast, root) : checkGuards(ast, root, path.basename(filePath));
  // A gate whose tests rows all matched in the last `guard --test --dir` run of this very file is said to be tested.
  const tested = testedGateIds(root, source);
  for (const item of report.items) if (item.kind === "gate" && tested.has(item.id)) item.tested = true;
  console.log(`guard --check ${filePath} (project: ${dirPath})`);
  console.log("");
  for (const line of renderGuardReport(report)) console.log(line);
  for (const line of otherRecordLines(root, target, path.basename(filePath))) console.log(line);
  // Listed only: an island's test command is never run here.
  const islands = ast.islands ?? [];
  if (islands.length) {
    console.log("");
    console.log("islands (test commands are listed, not run):");
    for (const x of islands) console.log(`  island ${x.id}  owner ${x.owner || "(none)"}  ${x.path}${x.test ? `  test: ${x.test}` : "  (no test command)"}`);
  }
  // A plugin's own rows (EXPERIMENTAL), after everything the core checked: claimed by the plugin, not counted in the total, no say in the exit code.
  const claimed = pluginReportLines(ast, { target });
  if (claimed.length) {
    console.log("");
    for (const line of claimed) console.log(line);
  }
  process.exit(report.missing > 0 ? 1 : 0);
}

/**
 * `guard <file> --test`: run each tests row of the gates and hooks through the generated
 * scripts (src/guard/test-run.ts). Scaffolds into a temp folder, or into --dir (files
 * already there are kept). Exit 1 on a row that is not what it was written to be, on a
 * topology that does not validate for the target (V141/V142 included), and when there
 * is no row to run.
 */
function cmdGuardTest(filePath: string, targetName: string | undefined, dirPath: string | undefined): void {
  const target = targetName ?? "claude-code";
  if (target !== "claude-code" && target !== "codex") {
    console.error(c.red(`Error: guard --test supports claude-code and codex only (got "${target}").`));
    process.exit(1);
  }
  const ast = parseAt(readFile(filePath), filePath);
  const errors = buildErrors(ast, target);
  if (errors.length > 0) {
    console.error(c.red(`  ${errors.length} validation error(s), so the scripts are not run:`));
    for (const e of errors.slice(0, 5)) console.error(`  ${c.red(`[${e.rule}]`)}${e.line ? ` line ${e.line}:` : ""} ${e.message}`);
    if (errors.length > 5) console.error(c.dim(`  … and ${errors.length - 5} more`));
    process.exit(1);
  }
  if (!hasTests(ast)) {
    console.error(c.red(`Error: ${filePath} has no tests rows: write tests { refuse: ["<command>"] allow: ["<command>"] } on a gate or a hook.`));
    process.exit(1);
  }
  const own = dirPath === undefined;
  const dir = path.resolve(own ? fs.mkdtempSync(path.join(os.tmpdir(), "agentopology-guard-test-")) : dirPath);
  let run;
  try {
    run = runGuardTests(ast, dir, target);
  } catch (err) {
    // a binding that refuses the topology (Codex and a Claude model): one line, exit 1
    console.error(c.red(`Error: ${(err as Error).message}`));
    if (own) fs.rmSync(dir, { recursive: true, force: true });
    process.exit(1);
  }
  console.log(`guard --test ${filePath} (${own ? "temp project" : `project: ${dirPath}`}, ${target})`);
  console.log("");
  for (const line of renderTestRun(run)) console.log(line);
  if (own) fs.rmSync(dir, { recursive: true, force: true });
  // With --dir the project is known: leave what passed for `guard --check --dir` to say `tested`.
  else writeTestResults(dir, readFile(filePath), run);
  process.exit(run.misses > 0 || run.results.length === 0 ? 1 : 0);
}

/**
 * `guard <file> --target claude-code|codex`: write only the guard part of scaffold's
 * output (see src/guard/target.ts), print what was written or kept, then run
 * the `--check` report and exit like it.
 */
function cmdGuardTarget(filePath: string, targetName: string, dirPath: string, dryRun: boolean): void {
  if (targetName !== "claude-code" && targetName !== "codex") {
    console.error(c.red(`Error: guard --target supports claude-code and codex only (got "${targetName}").`));
    process.exit(1);
  }
  const source = readFile(filePath);
  let ast;
  try {
    ast = forTarget(parseAt(source, filePath), targetName);
  } catch (err) {
    if (err instanceof PluginError) throw err;
    console.error(c.red(`Parse error: ${(err as Error).message}`));
    process.exit(1);
  }
  const errors = buildErrors(ast, targetName);
  if (errors.length > 0) {
    console.error(c.red(`  ${errors.length} validation error(s). Nothing was written.`));
    for (const e of errors.slice(0, 5)) console.error(`  ${c.red(`[${e.rule}]`)}${e.line ? ` line ${e.line}:` : ""} ${e.message}`);
    process.exit(1);
  }
  const root = path.resolve(dirPath);
  const name = path.basename(filePath);
  let plan;
  try {
    plan = planGuardTarget(ast, root, name, targetName);
  } catch (e) {
    exitOnInvalidSettings(e);
    exitOnInvalidManifest(e);
    if (e instanceof BindingRefusal) {
      console.error(c.red(`  ${e.message}`));
      process.exit(1);
    }
    throw e;
  }
  const unsafe = plan.actions.filter((a) => a.type === "blocked" && a.unsafe);
  if (unsafe.length > 0) {
    console.error(c.red(`  Refusing to write: ${unsafe.length} generated path(s) are not safe file names. Nothing was written.`));
    process.exit(1);
  }

  console.log(c.bold(`guard --target ${targetName} ${filePath} (project: ${dirPath})${dryRun ? c.cyan(" — dry run, nothing is written") : ""}`));
  // R-9: the line names the host the output was written for, not always Claude Code.
  const conf = targetName === "codex" ? platformConformance("codex") : null;
  if (conf) {
    const mark = conf.installedMark();
    if (mark) console.log(c.dim(`  ${mark}`));
    console.log(c.dim(`  ${conf.verifiedOnLine()}`));
  } else {
    console.log(c.dim(`  ${verifiedOnLine()}`));
  }
  console.log("");
  for (const a of plan.actions) {
    if (a.type === "create") console.log(`  ${c.green("+")} ${a.path}`);
    else if (a.type === "update") {
      console.log(`  ${c.yellow("~")} ${a.path} (${a.detail})`);
      for (const hook of a.removedHooks ?? []) console.log(`  ${c.red("-")} removed generated hook ${hook}`);
      if (dryRun) {
        for (const line of jsonChanges(fs.readFileSync(path.join(root, a.path), "utf-8"), a.content)) console.log(`      ${c.dim(line)}`);
      }
    } else if (a.type === "unchanged") console.log(`  ${c.dim("=")} ${a.path}`);
  }
  for (const s of plan.skipped) console.log(`  ${c.bold("!")} ${s.path} (${s.why})`);
  printRuleNotice(plan.notice);
  console.log("");

  if (dryRun) {
    const writes = plan.actions.filter((a) => a.type === "create" || a.type === "update").length;
    console.log(`  ${writes} file(s) would be written, ${plan.skipped.length} kept.`);
    return;
  }
  let result;
  try {
    result = applyGuardTarget(plan, root, name, source, targetName);
  } catch (err) {
    console.error(c.red(`  Could not write: ${(err as Error).message}`));
    process.exit(1);
  }
  console.log(`  ${result.created} created, ${result.updated} updated, ${result.unchanged} unchanged, ${plan.skipped.length} kept`);
  if (result.failures.length > 0) {
    for (const f of result.failures) console.error(`  ${c.red("✗")} ${f.path} — ${f.error}`);
    process.exit(1);
  }
  console.log("");
  if (targetName === "codex") {
    // guard --check grades Claude Code settings only for now; say what a person must do instead.
    console.log("  Codex skips a project hook until it is reviewed and trusted: open /hooks in Codex and trust the hooks in .codex/hooks.json.");
    console.log("  Until then no guard is active, and a hook is a guardrail, not a sandbox. agentopology never writes a trust entry.");
    return;
  }
  cmdGuardCheck(filePath, dirPath);
}

/**
 * `fix <file.at> [--target <binding>] [--write]`: grade each gate V135
 * errors on `strength: hope`. Exit 0: nothing (left) to fix. Exit 2: a dry
 * run found gates to fix and wrote nothing (2, not 1, so a script can tell
 * "there is work" from "the command failed"). Exit 1: no file, a parse
 * error, an unknown target, --write with --dry-run, --write on a file that
 * is not valid UTF-8, or a V135 error left after --write. A V135 error in an
 * imported file counts in both verdicts; it is fixed in that file.
 */
function cmdFix(filePath: string, target: string | undefined, write: boolean, dryRun: boolean): void {
  if (write && dryRun) {
    console.error(c.red("Error: --write and --dry-run cannot be used together; fix without --write is the dry run. Nothing written."));
    process.exit(1);
  }
  if (target && !bindings[target]) {
    console.error(c.red(`Error: unknown target "${target}". Available: ${Object.keys(bindings).join(", ")}`));
    process.exit(1);
  }
  const resolved = path.resolve(filePath);
  if (!fs.existsSync(resolved)) {
    console.error(c.red(`Error: file not found: ${resolved}`));
    process.exit(1);
  }
  const bytes = fs.readFileSync(resolved);
  const source = bytes.toString("utf-8");
  const name = path.basename(filePath);
  // Writing the decoded text back would turn each byte that is not UTF-8
  // into U+FFFD (EF BF BD), changing bytes outside the edited lines.
  if (write && !Buffer.from(source, "utf-8").equals(bytes)) {
    console.error(c.red(`Error: ${name} is not valid UTF-8, so --write would change bytes outside the lines it edits. Nothing written; save it as UTF-8 first, or add strength: hope by hand.`));
    process.exit(1);
  }
  checkRequiresInText(source, filePath);
  const importLine = (p: { relayed: unknown[]; relayedFiles: string[] }) =>
    `${p.relayed.length} V135 error(s) in imported files: run fix on ${p.relayedFiles.map((f) => path.relative(process.cwd(), f) || f).join(", ")}`;
  const on = target ? `--target ${target}` : "no target";
  let plan;
  try {
    plan = planV135Fixes(source, { target, filePath: resolved });
  } catch (err) {
    console.error(c.red(`Parse error: ${name}: ${(err as Error).message}`));
    process.exit(1);
  }
  if (!plan.applies) {
    console.log(`V135 does not apply to --target ${target}: nothing to fix in ${name}.`);
    process.exit(0);
  }
  if (plan.fixes.length === 0 && plan.relayed.length === 0) {
    console.log(c.green(`Nothing to fix in ${name} (V135, ${on}).`));
    process.exit(0);
  }
  if (plan.fixes.length > 0) console.log(`${c.bold(name)}: ${plan.fixes.length} gate(s) meant to refuse that no generated hook runs (V135, ${on}):`);
  for (const f of plan.fixes) {
    console.log("");
    console.log(`  gate "${f.gate}"${f.line !== undefined ? ` (line ${f.line})` : ""}`);
    console.log(`    why: no hook runs it: ${f.reason}`);
    if (f.edit) {
      console.log(f.edit.kind === "insert"
        ? `    fix: add strength: hope after line ${f.edit.line}, its run: line (nothing enforces it today; the playbook runs it)`
        : `    fix: strength: refuse becomes strength: hope on line ${f.edit.line} (nothing enforces it today; the playbook runs it)`);
    } else {
      console.log(c.yellow(`    fix: ${f.manual}`));
    }
    if (f.suggestions.length === 0) console.log(`    to make it refuse: no subagent or script step next to it in the flow; anchor it yourself`);
    for (const s of f.suggestions) console.log(`    to make it refuse (a suggestion, not applied): ${s}`);
  }
  if (plan.fixes.length > 0) console.log("");
  if (plan.relayed.length > 0) console.log(c.yellow(importLine(plan)));
  const editable = plan.fixes.filter((f) => f.edit).length;
  if (!write) {
    console.log(editable > 0
      ? `Dry run: Nothing written. Run with --write to add strength: hope to ${editable} gate(s).`
      : "Dry run: Nothing written; nothing here that --write can edit.");
    process.exit(2);
  }
  if (editable > 0) {
    fs.writeFileSync(resolved, applyV135Fixes(source, plan), "utf-8");
    console.log(`Wrote ${name}: strength: hope on ${editable} gate(s); nothing else changed.`);
  } else {
    console.log(`Nothing written to ${name}: no gate here that fix can edit.`);
  }
  const after = planV135Fixes(fs.readFileSync(resolved, "utf-8"), { target, filePath: resolved });
  if (after.fixes.length === 0 && after.relayed.length === 0) {
    console.log(c.green(`validate: no V135 error left (${on}).`));
    process.exit(0);
  }
  if (after.fixes.length > 0) {
    console.error(c.red(`validate: ${after.fixes.length} V135 error(s) left: ${after.fixes.map((f) => f.gate).join(", ")}. Edit them by hand.`));
  }
  if (after.relayed.length > 0) console.error(c.red(`validate: ${importLine(after)}.`));
  process.exit(1);
}

function cmdStubs(dirPath: string): void {
  const resolved = path.resolve(dirPath);
  if (!fs.existsSync(resolved)) {
    console.error(c.red(`Error: directory not found: ${resolved}`));
    process.exit(1);
  }

  const stubs: string[] = [];

  function walk(dir: string): void {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      // Skip common non-source directories so a big repo scan stays fast.
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === ".git" || entry.name === "dist") continue;
        walk(path.join(dir, entry.name));
        continue;
      }
      const full = path.join(dir, entry.name);
      // Marker only appears in text files; skip anything that isn't readable as UTF-8.
      let content: string;
      try {
        content = fs.readFileSync(full, "utf-8");
      } catch {
        continue;
      }
      if (isStubContent(content)) {
        stubs.push(path.relative(resolved, full));
      }
    }
  }
  walk(resolved);

  if (stubs.length === 0) {
    console.log(c.green(`  No unimplemented stubs found in ${resolved}`));
    return;
  }
  console.log(
    c.yellow(
      `  ${c.bold(`${stubs.length}`)} stub(s) need implementation in ${resolved}:`,
    ),
  );
  for (const rel of stubs.sort()) {
    console.log(`    ${c.yellow("·")} ${rel}`);
  }
  console.log("");
  console.log(
    c.dim(`  Search for "${STUB_MARKER}" — remove that line when each script is implemented.`),
  );
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

/** `<pluginId>:<name>`: a command a plugin adds (EXPERIMENTAL). No core command has a colon. */
function isPluginCommand(command: string): boolean {
  return /^[A-Za-z][A-Za-z0-9_-]*:[a-z][a-z0-9-]*$/.test(command);
}

/** Commands that read an .at file, and so may load plugins. */
const PLUGIN_COMMANDS: ReadonlySet<string> = new Set(["validate", "fix", "scaffold", "sync", "visualize", "export", "plan", "info", "guard"]);

/**
 * The plugin modules this run asks for (EXPERIMENTAL): the `--plugin` flags,
 * then the project's package.json `agentopology.plugins`. The project folder
 * is --dir, else the working folder: never the .at's own folder, so a cloned
 * folder's package.json runs nothing when its .at is only named. Nothing an
 * .at says is read here.
 */
function pluginRequests(args: ParsedArgs): { requests: PluginRequest[]; projectDir: string } {
  const pluginCommand = !!args.command && isPluginCommand(args.command);
  const projectDir = path.resolve(args.dir ?? ".");
  if (!args.command || !(PLUGIN_COMMANDS.has(args.command) || pluginCommand)) return { requests: [], projectDir };
  // --no-plugins: no plugin at all, neither --plugin nor package.json (a write gate's reads need it).
  if (args.noPlugins) return { requests: [], projectDir };
  const flags = args.plugins.map((spec) => ({ spec, base: process.cwd(), from: "--plugin" }));
  return { requests: [...flags, ...packagePluginRequests(projectDir)], projectDir };
}

/** Load the requested plugins, print each, set them for every parse, then run the command; a plugin error exits 1. */
async function mainWithPlugins(args: ParsedArgs, requests: PluginRequest[], projectDir: string): Promise<void> {
  try {
    const loaded = await loadPlugins(requests, projectDir);
    for (const p of loaded) console.error(`loaded plugin ${p.plugin.id}@${p.version} from ${p.path}`);
    setActivePlugins(loaded.map((p) => p.plugin));
    main(args);
  } catch (err) {
    if (!(err instanceof PluginError)) throw err;
    console.error(c.red(`Error: ${err.message}`));
    process.exit(1);
  }
}

/** A plugin's gate checks (gateRuns) for this target, applied before validation and generation; `ast` itself without plugins. */
function forTarget<T extends TopologyAST>(ast: T, target: string | undefined): T {
  return target ? (preparePluginTarget(ast, target) as T) : ast;
}

function main(args: ParsedArgs): void {
  if (args.help || !args.command) {
    usage();
    process.exit(args.help ? 0 : 1);
  }

  switch (args.command) {
    case "validate":
      if (!args.file) {
        console.error(c.red("Error: validate requires a file argument."));
        usage();
        process.exit(1);
      }
      cmdValidate(args.file, args.inventory, args.dir, args.user, args.more, args.target, args.json);
      break;

    case "fix":
      if (!args.file) {
        console.error(c.red("Error: fix requires a file argument."));
        usage();
        process.exit(1);
      }
      cmdFix(args.file, args.target, args.write, args.dryRun);
      break;

    case "inventory":
      {
        const roots = args.at.flatMap((f) => {
          try { return parseAt(readFile(f), f).inventoryRoots ?? []; } catch (err) {
            console.error(c.red(`Parse error: ${f}: ${(err as Error).message}`));
            process.exit(1);
          }
        });
        console.log(JSON.stringify({ version: 1, items: collectInventory(path.resolve(args.file ?? args.dir ?? "."), { roots, user: args.user }) }, null, 2));
      }
      break;

    case "scaffold":
      if (!args.file) {
        console.error(c.red("Error: scaffold requires a file argument."));
        usage();
        process.exit(1);
      }
      if (!args.target) {
        console.error(c.red("Error: scaffold requires --target <binding>."));
        usage();
        process.exit(1);
      }
      cmdScaffold(args.file, args.target, args.dryRun, args.output || args.dir, args.force, args.prune, args.allowInvalid);
      break;

    case "sync":
      if (!args.file) {
        console.error(c.red("Error: sync requires a file argument."));
        usage();
        process.exit(1);
      }
      if (!args.target) {
        console.error(c.red("Error: sync requires --target <binding>."));
        usage();
        process.exit(1);
      }
      if (!args.dir) {
        console.error(c.red("Error: sync requires --dir <path>."));
        usage();
        process.exit(1);
      }
      cmdSync(args.file, args.target, args.dir);
      break;

    case "visualize":
      cmdVisualize(args.file, args.output, { dir: args.dir, noOpen: args.noOpen, noCheck: args.noCheck, printSummary: args.printSummary });
      break;

    case "visualize-brain":
      if (!args.file) {
        console.error(c.red("Error: visualize-brain requires a vault folder argument."));
        usage();
        process.exit(1);
      }
      cmdVisualizeBrain(args.file, args.output, args.noOpen);
      break;

    case "export":
      if (!args.file) {
        console.error(c.red("Error: export requires a file argument."));
        usage();
        process.exit(1);
      }
      if (!args.format) {
        console.error(c.red("Error: export requires --format <markdown|mermaid|json|ascii|brief>."));
        usage();
        process.exit(1);
      }
      cmdExport(args.file, args.format, args.output);
      break;

    case "plan":
      if (!args.file) {
        console.error(c.red("Error: plan requires a file argument."));
        usage();
        process.exit(1);
      }
      cmdPlan(args.file, args.mode, args.brief, args.log, args.task, args.root);
      break;

    case "info":
      if (!args.file) {
        console.error(c.red("Error: info requires a file argument."));
        usage();
        process.exit(1);
      }
      cmdInfo(args.file);
      break;

    case "import":
      if (!args.target) {
        console.error(c.red("Error: import requires --target <binding>."));
        usage();
        process.exit(1);
      }
      if (!args.dir) {
        console.error(c.red("Error: import requires --dir <path>."));
        usage();
        process.exit(1);
      }
      cmdImport(args.target, args.dir, args.name, args.output, args.force);
      break;

    case "targets":
      cmdTargets();
      break;

    case "guard": {
      if (!args.file) {
        console.error(c.red("Error: guard requires a file argument."));
        process.exit(1);
      }
      if (args.test) {
        cmdGuardTest(args.file, args.target, args.dir);
        break;
      }
      // E-2: --check reads and never writes, on any target.
      if (args.check) {
        cmdGuardCheck(args.file, args.dir ?? ".", args.target);
        break;
      }
      if (args.target) {
        cmdGuardTarget(args.file, args.target, args.dir ?? ".", args.dryRun);
        break;
      }
      if (!args.check) {
        console.error(c.red("Error: guard needs --check (read-only report), --test (run the tests rows) or --target claude-code|codex (write the guards)."));
        process.exit(1);
      }
      cmdGuardCheck(args.file, args.dir ?? ".");
      break;
    }

    case "step": {
      // `agentopology step check <file.at> <step-id> [--unit U] [--dir D]`
      const rest = process.argv.slice(2);
      const sub = rest[rest.indexOf("step") + 1];
      const a = parseStepArgs(rest.slice(rest.indexOf("step") + 2));
      if (sub !== "check" || !a.file || !a.step) {
        console.error(c.red("Usage: agentopology step check <file.at> <step-id> [--unit U] [--dir D]"));
        process.exit(1);
      }
      const stepAst = parse(readFile(a.file));
      checkRequires(stepAst, a.file);
      const report = checkStep(stepAst, a.step, { unit: a.unit, dir: a.dir ?? "." });
      for (const line of renderStepReport(report)) (report.ok ? console.log : console.error)(line);
      process.exit(report.ok ? 0 : 1);
    }

    case "stubs": {
      // `agentopology stubs [<dir>]` — scan for unimplemented scaffold stubs.
      // Default to the current working directory if no path given.
      const dir = args.file ?? args.dir ?? ".";
      cmdStubs(dir);
      break;
    }

    case "docs":
      if (args.agentGuide) {
        // The compact path. getAllTopics() is ~104 KB — loading it to write one
        // topology is the opposite of context-efficient.
        console.log(getAgentGuide());
      } else if (args.all) {
        console.log(getAllTopics());
      } else if (args.search) {
        console.log(searchTopics(args.search));
      } else if (args.file) {
        // args.file is actually the topic name (second positional arg)
        const content = getTopic(args.file);
        if (!content) {
          console.error(c.red(`Unknown topic: "${args.file}"`));
          console.log("");
          console.log(listTopics());
          process.exit(1);
        }
        console.log(content);
      } else {
        console.log(listTopics());
      }
      break;

    default:
      if (isPluginCommand(args.command)) {
        // The words after the command, the file slot included: the plugin reads them as it likes.
        try {
          process.exit(runPluginCommand(args.command, [...(args.file ? [args.file] : []), ...args.more], { cwd: process.cwd(), projectDir: path.resolve(args.dir ?? ".") }));
        } catch (err) {
          if (!(err instanceof PluginError)) throw err;
          console.error(c.red(`Error: ${err.message}`));
          process.exit(1);
        }
      }
      console.error(c.red(`Unknown command: "${args.command}"`));
      usage();
      process.exit(1);
  }
}

// Without plugins the run is synchronous, exactly as before; loading a plugin
// needs dynamic import(), so with one the command runs after it loads.
{
  // --version / -v as the first word: print the version, nothing else.
  const first = process.argv[2];
  if (first === "--version" || first === "-v") {
    console.log(packageVersion());
    process.exit(0);
  }
  const args = parseArgs(process.argv);
  let wanted: ReturnType<typeof pluginRequests>;
  try {
    wanted = pluginRequests(args);
  } catch (err) {
    if (!(err instanceof PluginError)) throw err;
    console.error(c.red(`Error: ${err.message}`));
    process.exit(1);
  }
  if (wanted.requests.length === 0) main(args);
  else void mainWithPlugins(args, wanted.requests, wanted.projectDir);
}

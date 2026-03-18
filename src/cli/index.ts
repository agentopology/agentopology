#!/usr/bin/env node
/**
 * AgenTopology CLI.
 *
 * Commands:
 *   agentopology validate <file.at>                        — parse and validate
 *   agentopology scaffold <file.at> --target <binding>     — generate files
 *   agentopology scaffold <file.at> --target <binding> --dry-run — preview only
 *   agentopology sync <file.at> --target <binding> --dir <path> — sync prompts back
 *   agentopology visualize <file.at>                          — generate HTML visualization
 *   agentopology targets                                   — list bindings
 *   agentopology docs [topic]                              — language reference
 *   agentopology docs --all                                — all docs (LLM ingestion)
 *   agentopology docs --search <term>                      — search docs
 *
 * @module
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { execSync } from "node:child_process";
import { parse } from "../parser/index.js";
import { validate } from "../parser/validator.js";
import { bindings } from "../bindings/index.js";
import { syncFromPlatform } from "../sync/index.js";
import type { PlatformFile } from "../sync/index.js";
import { generateVisualization } from "../visualizer/index.js";
import { exporters } from "../exporters/index.js";
import { analyze } from "../analyzer/index.js";
import { listTopics, getTopic, getAllTopics, searchTopics } from "../docs/index.js";
import { importFromPlatform } from "../import/index.js";
import { readManifest, writeManifest, hashContent } from "../scaffold/manifest.js";
import { computeIncrementalPlan, executeActions } from "../scaffold/incremental.js";
import type { ScaffoldManifest } from "../scaffold/types.js";

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
  agentopology validate <file.at>
  agentopology scaffold <file.at> --target <binding> [--dry-run] [--force] [--prune] [--output <dir>]
  agentopology sync <file.at> --target <binding> --dir <path>
  agentopology visualize <file.at> [--output <dir>]
  agentopology export <file.at> --format <markdown|mermaid|json> [--output <dir>]
  agentopology info <file.at>
  agentopology import --target <binding> --dir <path> [--name <topology-name>] [--output <dir>]
  agentopology targets
  agentopology docs [topic]
  agentopology docs --all
  agentopology docs --search <term>

${c.bold("Commands:")}
  validate   Parse an .at file and run all 29 validation rules.
  scaffold   Generate project files for a target platform.
  sync       Sync prompt content from platform files back into .at source.
  visualize  Generate an interactive HTML visualization of the topology.
  export     Export topology as Markdown documentation or Mermaid diagram.
  info       Analyze topology: detect patterns, compute layers, suggest improvements.
  import     Reverse-engineer platform files into an .at topology file.
  targets    List available binding targets.
  docs       Language reference — show documentation for .at syntax and features.

${c.bold("Options:")}
  --target <name>   Binding target (e.g. claude-code, codex, gemini-cli, copilot-cli, kiro)
  --format <name>   Export format (markdown, mermaid, json).
  --dir <path>      Directory to read platform files from (used with sync, import).
  --name <name>     Topology name for the generated .at file (used with import).
  --output, -o <dir> Output directory for generated files (scaffold, visualize, export).
  --dry-run         Preview generated files without writing to disk.
  --force           Overwrite all files, ignoring manifest and conflicts.
  --prune           Delete files that were previously scaffolded but are no longer generated.
  --all             Show all documentation topics (for LLM ingestion).
  --search <term>   Search across all documentation topics.
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

/** Recursively create directories and write a file. */
function writeFile(basePath: string, relativePath: string, content: string): void {
  const fullPath = path.join(basePath, relativePath);
  const dir = path.dirname(fullPath);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(fullPath, content, "utf-8");
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
  force: boolean;
  prune: boolean;
  all: boolean;
  search: string | undefined;
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
    force: false,
    prune: false,
    all: false,
    search: undefined,
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

    // Positional arguments
    if (!result.command) {
      result.command = arg;
    } else if (!result.file) {
      result.file = arg;
    }
    i++;
  }

  return result;
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

function cmdValidate(filePath: string): void {
  const source = readFile(filePath);

  let ast;
  try {
    ast = parse(source);
  } catch (err) {
    console.error(c.red(`Parse error: ${(err as Error).message}`));
    process.exit(1);
  }

  console.log(
    c.bold(`Validating ${path.basename(filePath)} (${ast.topology.name} v${ast.topology.version})`)
  );
  console.log("");

  const results = validate(ast);

  if (results.length === 0) {
    console.log(c.green("  All 29 validation rules passed."));
    console.log("");
    return;
  }

  const errors = results.filter((r) => r.level === "error");
  const warnings = results.filter((r) => r.level === "warning");

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
    `  ${c.red(`${errors.length} error(s)`)}, ${c.yellow(`${warnings.length} warning(s)`)}`
  );
  console.log("");

  if (errors.length > 0) {
    process.exit(1);
  }
}

function cmdScaffold(filePath: string, targetName: string, dryRun: boolean, outputDir?: string, force?: boolean, prune?: boolean): void {
  const source = readFile(filePath);

  let ast;
  try {
    ast = parse(source);
  } catch (err) {
    console.error(c.red(`Parse error: ${(err as Error).message}`));
    process.exit(1);
  }

  const binding = bindings[targetName];
  if (!binding) {
    console.error(c.red(`Unknown target: "${targetName}"`));
    console.error(`Available targets: ${Object.keys(bindings).join(", ")}`);
    process.exit(1);
  }

  console.log(
    c.bold(`Scaffolding ${ast.topology.name} for ${binding.description}`)
  );
  console.log("");

  const files = binding.scaffold(ast);

  if (files.length === 0) {
    console.log(c.yellow("  No files generated."));
    return;
  }

  const basePath = outputDir ? path.resolve(outputDir) : process.cwd();

  if (dryRun) {
    console.log(c.cyan("  Dry run — files that would be generated:"));
    console.log("");

    const manifest = readManifest(basePath, targetName);
    if (manifest && !force) {
      const actions = computeIncrementalPlan(basePath, targetName, files, manifest);
      for (const action of actions) {
        switch (action.type) {
          case "create": console.log(`  ${c.green("+")} ${action.path}`); break;
          case "update": console.log(`  ${c.yellow("~")} ${action.path} (${action.detail})`); break;
          case "delete": console.log(`  ${c.red("-")} ${action.path}`); break;
          case "unchanged": console.log(`  ${c.dim("=")} ${action.path}`); break;
          case "conflict": console.log(`  ${c.bold("!")} ${action.path} (${action.detail})`); break;
        }
      }
    } else {
      for (const file of files) {
        console.log(`  ${c.green("+")} ${file.path} (${file.content.length} bytes)`);
      }
    }
    console.log("");
    console.log(`  ${files.length} file(s) would be generated.`);
  } else {
    const manifest = readManifest(basePath, targetName);

    if (manifest && !force) {
      // INCREMENTAL MODE
      const actions = computeIncrementalPlan(basePath, targetName, files, manifest);
      const result = executeActions(basePath, actions, { prune: !!prune, force: !!force });

      for (const action of actions) {
        switch (action.type) {
          case "create": console.log(`  ${c.green("+")} ${action.path}`); break;
          case "update": console.log(`  ${c.yellow("~")} ${action.path}`); break;
          case "delete": if (prune) console.log(`  ${c.red("-")} ${action.path}`); break;
          case "unchanged": break;
          case "conflict": console.log(`  ${c.bold("!")} ${action.path} (preserved — user edited)`); break;
        }
      }
      console.log("");
      console.log(`  ${result.created} created, ${result.updated} updated, ${result.unchanged} unchanged, ${result.conflicts} conflicts${prune ? `, ${result.deleted} deleted` : ""}`);
    } else {
      // FIRST RUN or --force — write everything
      for (const file of files) {
        writeFile(basePath, file.path, file.content);
        console.log(`  ${c.green("+")} ${file.path}`);
      }
      console.log("");
      console.log(`  ${c.bold(`${files.length}`)} file(s) written to ${basePath}`);
    }

    // Always write manifest after successful scaffold
    const newManifest: ScaffoldManifest = {
      source: path.basename(filePath),
      sourceHash: hashContent(source),
      target: targetName,
      generatedAt: new Date().toISOString(),
      files: {},
    };
    for (const file of files) {
      newManifest.files[file.path] = {
        hash: hashContent(file.content),
        category: file.category || "machine",
      };
    }
    writeManifest(basePath, targetName, newManifest);
  }
  console.log("");
}

function readDirRecursive(dirPath: string): PlatformFile[] {
  const resolved = path.resolve(dirPath);
  if (!fs.existsSync(resolved)) {
    console.error(c.red(`Error: directory not found: ${resolved}`));
    process.exit(1);
  }

  const files: PlatformFile[] = [];
  function walk(dir: string, prefix: string): void {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const rel = path.join(prefix, entry.name);
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full, rel);
      } else {
        files.push({ path: rel, content: fs.readFileSync(full, "utf-8") });
      }
    }
  }
  walk(resolved, "");
  return files;
}

function cmdSync(filePath: string, targetName: string, dirPath: string): void {
  const atSource = readFile(filePath);
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

function cmdVisualize(filePath: string, outputDir?: string): void {
  const source = readFile(filePath);

  let ast;
  try {
    ast = parse(source);
  } catch (err) {
    console.error(c.red(`Parse error: ${(err as Error).message}`));
    process.exit(1);
  }

  const html = generateVisualization(ast);

  const resolved = path.resolve(filePath);
  const stem = path.basename(resolved, ".at");
  const outDir = outputDir ? path.resolve(outputDir) : path.dirname(resolved);
  const outFile = path.join(outDir, `${stem}-topology.html`);

  try {
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(outFile, html, "utf-8");
  } catch (err) {
    console.error(c.red(`Error: Cannot write "${outFile}"`));
    console.error((err as Error).message);
    process.exit(1);
  }

  console.log(c.green(`  Visualization written to ${outFile}`));

  // Try to open in the default browser (non-fatal if it fails).
  const openCmd = process.platform === "darwin" ? "open" : "xdg-open";
  try {
    execSync(`${openCmd} "${outFile}"`, { stdio: "ignore" });
  } catch {
    // Non-fatal — the file was written successfully regardless.
  }
}

function cmdExport(filePath: string, formatName: string, outputDir?: string): void {
  const source = readFile(filePath);

  let ast;
  try {
    ast = parse(source);
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

function cmdInfo(filePath: string): void {
  const source = readFile(filePath);

  let ast;
  try {
    ast = parse(source);
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
      const prefix = s.level === "improvement" ? c.yellow("[improvement]") : c.dim("[info]");
      const nodePart = s.node ? ` ${c.cyan(s.node)}:` : "";
      console.log(`  ${prefix}${nodePart} ${s.message}`);
    }
    console.log("");
  }
}

function cmdImport(targetName: string, dirPath: string, topologyName?: string, outputDir?: string): void {
  const files = readDirRecursive(dirPath);

  const name = topologyName ?? path.basename(path.resolve(dirPath)).replace(/^\./, "");

  console.log(
    c.bold(`Importing from ${targetName} files in ${dirPath}`)
  );
  console.log("");

  let atSource: string;
  try {
    atSource = importFromPlatform(files, targetName, name);
  } catch (err) {
    console.error(c.red(`Import error: ${(err as Error).message}`));
    process.exit(1);
  }

  // Determine output path
  const outDir = outputDir ? path.resolve(outputDir) : process.cwd();
  const outFile = path.join(outDir, `${name}.at`);

  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(outFile, atSource, "utf-8");
  console.log(c.green(`  Written: ${outFile}`));

  // Validate the generated file
  try {
    const ast = parse(atSource);
    const results = validate(ast);
    const errors = results.filter((r) => r.level === "error");
    const warnings = results.filter((r) => r.level === "warning");
    if (errors.length > 0 || warnings.length > 0) {
      console.log("");
      console.log(`  ${c.yellow(`${errors.length} error(s), ${warnings.length} warning(s) in generated file.`)}`);
      console.log(`  ${c.dim("Run")} agentopology validate ${outFile} ${c.dim("for details.")}`);
    } else {
      console.log(`  ${c.green("Generated file passes all validation rules.")}`);
    }
  } catch {
    // Validation is best-effort; don't fail the import
    console.log(`  ${c.yellow("Note: generated file may need manual review.")}`);
  }
  console.log("");
}

function cmdTargets(): void {
  console.log(c.bold("Available binding targets:"));
  console.log("");
  for (const [name, binding] of Object.entries(bindings)) {
    console.log(`  ${c.cyan(name.padEnd(16))} ${binding.description}`);
  }
  console.log("");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main(): void {
  const args = parseArgs(process.argv);

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
      cmdValidate(args.file);
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
      cmdScaffold(args.file, args.target, args.dryRun, args.output || args.dir, args.force, args.prune);
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
      if (!args.file) {
        console.error(c.red("Error: visualize requires a file argument."));
        usage();
        process.exit(1);
      }
      cmdVisualize(args.file, args.output);
      break;

    case "export":
      if (!args.file) {
        console.error(c.red("Error: export requires a file argument."));
        usage();
        process.exit(1);
      }
      if (!args.format) {
        console.error(c.red("Error: export requires --format <markdown|mermaid|json>."));
        usage();
        process.exit(1);
      }
      cmdExport(args.file, args.format, args.output);
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
      cmdImport(args.target, args.dir, args.name, args.output);
      break;

    case "targets":
      cmdTargets();
      break;

    case "docs":
      if (args.all) {
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
      console.error(c.red(`Unknown command: "${args.command}"`));
      usage();
      process.exit(1);
  }
}

main();

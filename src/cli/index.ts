/**
 * AgentTopology CLI.
 *
 * Commands:
 *   agentopology validate <file.at>                        — parse and validate
 *   agentopology scaffold <file.at> --target <binding>     — generate files
 *   agentopology scaffold <file.at> --target <binding> --dry-run — preview only
 *   agentopology targets                                   — list bindings
 *
 * @module
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { parse } from "../parser/index.js";
import { validate } from "../parser/validator.js";
import { bindings } from "../bindings/index.js";

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
${c.bold("agentopology")} — AgentTopology CLI

${c.bold("Usage:")}
  agentopology validate <file.at>
  agentopology scaffold <file.at> --target <binding> [--dry-run]
  agentopology targets

${c.bold("Commands:")}
  validate   Parse an .at file and run all 15 validation rules.
  scaffold   Generate project files for a target platform.
  targets    List available binding targets.

${c.bold("Options:")}
  --target <name>   Binding target (e.g. claude-code, codex, gemini-cli, copilot-cli)
  --dry-run         Preview generated files without writing to disk.
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
  dryRun: boolean;
  help: boolean;
}

function parseArgs(argv: string[]): ParsedArgs {
  const args = argv.slice(2); // skip node and script path
  const result: ParsedArgs = {
    command: undefined,
    file: undefined,
    target: undefined,
    dryRun: false,
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
    if (arg === "--target" && i + 1 < args.length) {
      result.target = args[i + 1];
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
    console.log(c.green("  All 15 validation rules passed."));
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
    const nodePart = result.node ? c.dim(` (${result.node})`) : "";
    console.log(`${prefix} ${result.message}${nodePart}`);
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

function cmdScaffold(filePath: string, targetName: string, dryRun: boolean): void {
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

  if (dryRun) {
    console.log(c.cyan("  Dry run — files that would be generated:"));
    console.log("");
    for (const file of files) {
      const size = Buffer.byteLength(file.content, "utf-8");
      const sizeStr = size > 0 ? c.dim(` (${size} bytes)`) : c.dim(" (empty)");
      console.log(`  ${c.green("+")} ${file.path}${sizeStr}`);
    }
    console.log("");
    console.log(`  ${c.bold(`${files.length}`)} file(s) would be generated.`);
  } else {
    const basePath = process.cwd();
    for (const file of files) {
      writeFile(basePath, file.path, file.content);
      console.log(`  ${c.green("+")} ${file.path}`);
    }
    console.log("");
    console.log(`  ${c.bold(`${files.length}`)} file(s) written.`);
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
      cmdScaffold(args.file, args.target, args.dryRun);
      break;

    case "targets":
      cmdTargets();
      break;

    default:
      console.error(c.red(`Unknown command: "${args.command}"`));
      usage();
      process.exit(1);
  }
}

main();

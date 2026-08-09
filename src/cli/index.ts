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
import { isStubContent, STUB_MARKER } from "../bindings/lib/stub.js";
import { syncFromPlatform } from "../sync/index.js";
import type { PlatformFile } from "../sync/index.js";
import { generateVisualization } from "../visualizer/index.js";
import { parseBrainVault, renderBrainHtml } from "../visualizer/brain.js";
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
  agentopology visualize-brain <vault-folder> [--output <dir>]
  agentopology export <file.at> --format <markdown|mermaid|json> [--output <dir>]
  agentopology info <file.at>
  agentopology import --target <binding> --dir <path> [--name <topology-name>] [--output <dir>]
  agentopology stubs [<project-dir>]
  agentopology targets
  agentopology docs [topic]
  agentopology docs --all
  agentopology docs --search <term>

${c.bold("Commands:")}
  validate   Parse an .at file and run all validation rules.
  scaffold   Generate project files for a target platform.
  sync       Sync prompt content from platform files back into .at source.
  visualize  Generate an interactive HTML visualization of the topology.
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
    console.log(c.green("  All validation rules passed."));
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
        writeFile(basePath, file.path, file.content, file.executable);
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

  // Stub summary: count and list any generated files that are unimplemented
  // stubs. We detect them by the AGENTOPOLOGY_STUB marker (see
  // src/bindings/lib/stub.ts). The summary goes to stderr so CI scripts can
  // capture it without polluting stdout.
  const stubFiles = files.filter((f) => isStubContent(f.content));
  if (stubFiles.length > 0) {
    console.error("");
    console.error(
      c.yellow(
        `  ${c.bold(`${stubFiles.length}`)} stub(s) need implementation before this topology can run:`,
      ),
    );
    for (const f of stubFiles) {
      console.error(`    ${c.yellow("·")} ${f.path}`);
    }
    console.error(
      c.dim(`  Search for "${STUB_MARKER}" — remove that line when each script is implemented.`),
    );
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
  const seen = new Set<string>();
  function walk(dir: string, prefix: string): void {
    // Guard against symlink cycles — a linked skill dir may point back into the tree.
    const real = fs.realpathSync(dir);
    if (seen.has(real)) return;
    seen.add(real);

    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const rel = path.join(prefix, entry.name);
      const full = path.join(dir, entry.name);
      // Dirent uses lstat semantics, so a symlinked directory reports as neither
      // file nor directory. Follow it with stat before deciding how to read it.
      let isDir = entry.isDirectory();
      let isFile = entry.isFile();
      if (entry.isSymbolicLink()) {
        try {
          const st = fs.statSync(full);
          isDir = st.isDirectory();
          isFile = st.isFile();
        } catch {
          continue; // broken symlink
        }
      }
      if (isDir) {
        walk(full, rel);
      } else if (isFile) {
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

  const resolved = path.resolve(filePath);
  const stem = path.basename(resolved, ".at");
  const outDir = outputDir ? path.resolve(outputDir) : path.dirname(resolved);
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

  const html = generateVisualization(ast, { brains });

  try {
    fs.writeFileSync(outFile, html, "utf-8");
  } catch (err) {
    console.error(c.red(`Error: Cannot write "${outFile}"`));
    console.error((err as Error).message);
    process.exit(1);
  }

  console.log(c.green(`  Visualization written to ${outFile}`));
  if (brains.length) console.log(c.dim(`  ${brains.length} brain graph(s) linked from the topology header.`));

  // Try to open in the default browser (non-fatal if it fails).
  const openCmd = process.platform === "darwin" ? "open" : "xdg-open";
  try {
    execSync(`${openCmd} "${outFile}"`, { stdio: "ignore" });
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
function cmdVisualizeBrain(vaultPath: string, outputDir?: string): void {
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

  const openCmd = process.platform === "darwin" ? "open" : "xdg-open";
  try {
    execSync(`${openCmd} "${outFile}"`, { stdio: "ignore" });
  } catch {
    // Non-fatal.
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

/**
 * Scan a scaffolded project directory for unimplemented stub scripts.
 *
 * A "stub" is a file that contains the AGENTOPOLOGY_STUB marker (emitted by
 * shellStub in src/bindings/lib/stub.ts). The marker is a comment line, so
 * removing it (after implementing the script) flips the file out of stub
 * state. Designed for CI: exits 1 if stubs remain, 0 if clean.
 */
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

    case "visualize-brain":
      if (!args.file) {
        console.error(c.red("Error: visualize-brain requires a vault folder argument."));
        usage();
        process.exit(1);
      }
      cmdVisualizeBrain(args.file, args.output);
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

    case "stubs": {
      // `agentopology stubs [<dir>]` — scan for unimplemented scaffold stubs.
      // Default to the current working directory if no path given.
      const dir = args.file ?? args.dir ?? ".";
      cmdStubs(dir);
      break;
    }

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

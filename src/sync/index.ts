/**
 * Sync-back module — extracts prompt content from platform agent files
 * and writes it back into .at file prompt {} blocks.
 * @module
 */

import { escapeRegex } from "../parser/lexer.js";

/** A platform file with its path and content. */
export interface PlatformFile {
  path: string;
  content: string;
}

/** Extracted prompt keyed by agent id. */
interface ExtractedPrompt {
  agentId: string;
  content: string;
}

/**
 * Sync prompt content from platform agent files back into an .at source string.
 *
 * @param atSource - Current .at file content
 * @param files - Platform agent files [{path, content}]
 * @param binding - Target binding name
 * @returns Updated .at file content with prompt {} blocks
 */
export function syncFromPlatform(
  atSource: string,
  files: PlatformFile[],
  binding: string,
): string {
  let prompts: ExtractedPrompt[];

  switch (binding) {
    case "claude-code":
      prompts = extractClaudeCodePrompts(files);
      break;
    case "codex":
      prompts = extractCodexPrompts(files);
      break;
    case "gemini-cli":
      prompts = extractGeminiPrompts(files);
      break;
    case "copilot-cli":
      prompts = extractCopilotPrompts(files);
      break;
    default:
      throw new Error(`Unknown binding: ${binding}`);
  }

  return insertPromptBlocks(atSource, prompts);
}

// ---------------------------------------------------------------------------
// Per-binding extractors
// ---------------------------------------------------------------------------

/**
 * Extract prompts from Claude Code agent files.
 *
 * Files matching `.claude/agents/<id>/AGENT.md` are parsed:
 * - Skip YAML frontmatter (between `---` markers)
 * - Look for `## Instructions` section
 * - Extract everything until a known structural heading or end of file
 */
function extractClaudeCodePrompts(files: PlatformFile[]): ExtractedPrompt[] {
  const prompts: ExtractedPrompt[] = [];

  for (const file of files) {
    // Match .claude/agents/<id>/AGENT.md (path is relative from --dir)
    const match = file.path.match(
      /(?:^|[\\/])agents[\\/]([^\\/]+)[\\/]AGENT\.md$/,
    );
    if (!match) continue;

    const agentId = match[1];
    const content = extractSectionUntilKnownHeading(
      file.content,
      "## Instructions",
      CLAUDE_CODE_STRUCTURAL_HEADINGS,
    );
    if (content) {
      prompts.push({ agentId, content });
    }
  }

  return prompts;
}

/** Known structural headings in Claude Code AGENT.md files (not part of prompt content). */
const CLAUDE_CODE_STRUCTURAL_HEADINGS = [
  "## Role",
  "## Reads",
  "## Writes",
  "## Outputs",
  "## Scale",
];

/** Known structural headings in Copilot .agent.md files. */
const COPILOT_STRUCTURAL_HEADINGS = [
  "## Role",
  "## Reads",
  "## Writes",
  "## Outputs",
  "## Scale",
];

/**
 * Extract prompts from Codex AGENTS.md file.
 *
 * Splits into per-agent sections by `### ` headings, then looks for
 * `#### Instructions` within each agent section.
 */
function extractCodexPrompts(files: PlatformFile[]): ExtractedPrompt[] {
  const prompts: ExtractedPrompt[] = [];

  const agentsFile = files.find(
    (f) => f.path.endsWith("AGENTS.md") || f.path === "AGENTS.md",
  );
  if (!agentsFile) return prompts;

  const agentSections = splitByHeading(agentsFile.content, "### ");

  for (const [heading, body] of agentSections) {
    // Heading is the agent title — convert back to kebab-case id
    const agentId = heading.trim().toLowerCase().replace(/\s+/g, "-");
    const content = extractSubsectionContent(body, "#### Instructions");
    if (content) {
      prompts.push({ agentId, content });
    }
  }

  return prompts;
}

/**
 * Extract prompts from Gemini CLI files.
 *
 * Finds the Gemini context file (`.gemini/CONTEXT.md` or legacy `GEMINI.md`),
 * splits agent sections under `## Agents` > `### AgentName`,
 * and extracts body content after metadata bullet points.
 */
function extractGeminiPrompts(files: PlatformFile[]): ExtractedPrompt[] {
  const prompts: ExtractedPrompt[] = [];

  const geminiFile = files.find(
    (f) => f.path.endsWith("GEMINI.md") || f.path === "GEMINI.md" ||
           f.path.endsWith(".gemini/CONTEXT.md"),
  );
  if (!geminiFile) return prompts;

  // Find the ## Agents section first
  const agentsSection = extractSectionContent(geminiFile.content, "## Agents");
  if (!agentsSection) return prompts;

  // Split into per-agent sections by ### headings
  const agentSections = splitByHeading(agentsSection, "### ");

  for (const [heading, body] of agentSections) {
    const agentId = heading.trim().toLowerCase().replace(/\s+/g, "-");

    // Extract content that's not metadata bullets (lines starting with `- `)
    // The prompt content is non-bullet text after the description/role paragraph
    // and before the metadata bullets
    const lines = body.split("\n");
    const contentLines: string[] = [];
    let foundBullets = false;
    let inPromptBlock = false;

    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith("- ") && !inPromptBlock) {
        foundBullets = true;
        continue;
      }
      // Skip empty lines before any content
      if (!inPromptBlock && trimmed === "") continue;
      // Once we've seen bullets, anything after is prompt content
      if (foundBullets && trimmed !== "") {
        inPromptBlock = true;
      }
      if (inPromptBlock) {
        contentLines.push(line);
      }
    }

    // If we didn't find content after bullets, try extracting the first
    // non-bullet paragraph (before the bullets)
    if (contentLines.length === 0) {
      const preLines: string[] = [];
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith("- ")) break;
        if (trimmed === "" && preLines.length === 0) continue;
        preLines.push(line);
      }
      // Only treat as prompt if it's more than a single short description line
      if (preLines.length > 1) {
        const content = preLines.join("\n").trim();
        if (content) {
          prompts.push({ agentId, content });
        }
      }
    } else {
      const content = contentLines.join("\n").trim();
      if (content) {
        prompts.push({ agentId, content });
      }
    }
  }

  return prompts;
}

/**
 * Extract prompts from Copilot CLI agent files.
 *
 * Files matching `.github/agents/<id>.agent.md` are parsed:
 * - Skip YAML frontmatter
 * - Look for `## Instructions` section
 */
function extractCopilotPrompts(files: PlatformFile[]): ExtractedPrompt[] {
  const prompts: ExtractedPrompt[] = [];

  for (const file of files) {
    const match = file.path.match(
      /(?:^|[\\/])agents[\\/]([^\\/]+)\.agent\.md$/,
    );
    if (!match) continue;

    const agentId = match[1];
    const content = extractSectionUntilKnownHeading(
      file.content,
      "## Instructions",
      COPILOT_STRUCTURAL_HEADINGS,
    );
    if (content) {
      prompts.push({ agentId, content });
    }
  }

  return prompts;
}

// ---------------------------------------------------------------------------
// Helpers for extraction
// ---------------------------------------------------------------------------

/**
 * Extract content of a markdown section (e.g., `## Instructions`).
 * Returns the text from after the heading line until the next heading
 * at the SAME or higher level (fewer #'s), or end of file.
 *
 * Headings at LOWER levels (more #'s, like ### inside ## Instructions)
 * are included in the extracted content — this is important because
 * prompt content often contains sub-headings.
 *
 * Skips YAML frontmatter if present.
 */
function extractSectionContent(
  fileContent: string,
  heading: string,
): string | null {
  // Strip YAML frontmatter
  let content = fileContent;
  if (content.startsWith("---")) {
    const endIdx = content.indexOf("---", 3);
    if (endIdx !== -1) {
      content = content.slice(endIdx + 3);
    }
  }

  const headingLevel = heading.split(" ")[0]; // e.g., "##"
  const headingPattern = new RegExp(
    `^${escapeRegex(heading)}\\s*$`,
    "m",
  );
  const match = headingPattern.exec(content);
  if (!match) return null;

  const start = match.index + match[0].length;
  const rest = content.slice(start);

  // Find the next heading at the SAME or higher level only
  // e.g., for ## Instructions, stop at ## but NOT at ###
  const nextHeadingPattern = new RegExp(
    `^#{1,${headingLevel.length}} `,
    "m",
  );
  const nextMatch = nextHeadingPattern.exec(rest);

  const sectionContent = nextMatch ? rest.slice(0, nextMatch.index) : rest;
  return sectionContent.trim() || null;
}

/**
 * Extract content of a markdown section until one of the known structural headings.
 *
 * Unlike extractSectionContent which stops at ANY heading at the same level,
 * this only stops at headings that are part of the binding's structural format.
 * This allows prompt content to contain arbitrary ## headings (like ## Guidelines).
 *
 * Skips YAML frontmatter if present.
 */
function extractSectionUntilKnownHeading(
  fileContent: string,
  heading: string,
  knownHeadings: string[],
): string | null {
  // Strip YAML frontmatter
  let content = fileContent;
  if (content.startsWith("---")) {
    const endIdx = content.indexOf("---", 3);
    if (endIdx !== -1) {
      content = content.slice(endIdx + 3);
    }
  }

  const headingPattern = new RegExp(
    `^${escapeRegex(heading)}\\s*$`,
    "m",
  );
  const match = headingPattern.exec(content);
  if (!match) return null;

  const start = match.index + match[0].length;
  const rest = content.slice(start);

  // Find the earliest occurrence of any known structural heading
  let endPos = rest.length;
  for (const kh of knownHeadings) {
    const khPattern = new RegExp(`^${escapeRegex(kh)}\\s*$`, "m");
    const khMatch = khPattern.exec(rest);
    if (khMatch && khMatch.index < endPos) {
      endPos = khMatch.index;
    }
  }

  const sectionContent = rest.slice(0, endPos);
  return sectionContent.trim() || null;
}

/**
 * Extract subsection content from a body string (not a full file).
 * Similar to extractSectionContent but operates on already-extracted text
 * without frontmatter handling.
 */
function extractSubsectionContent(
  body: string,
  heading: string,
): string | null {
  const headingLevel = heading.split(" ")[0];
  const headingPattern = new RegExp(
    `^${escapeRegex(heading)}\\s*$`,
    "m",
  );
  const match = headingPattern.exec(body);
  if (!match) return null;

  const start = match.index + match[0].length;
  const rest = body.slice(start);

  const nextHeadingPattern = new RegExp(
    `^#{1,${headingLevel.length}}\\s`,
    "m",
  );
  const nextMatch = nextHeadingPattern.exec(rest);

  const sectionContent = nextMatch ? rest.slice(0, nextMatch.index) : rest;
  return sectionContent.trim() || null;
}

/**
 * Split markdown content into sections by a heading prefix (e.g., "### ").
 * Returns an array of [headingText, bodyContent] pairs.
 */
function splitByHeading(
  content: string,
  headingPrefix: string,
): Array<[string, string]> {
  const results: Array<[string, string]> = [];
  const pattern = new RegExp(
    `^${escapeRegex(headingPrefix)}(.+)$`,
    "gm",
  );

  let lastMatch: RegExpExecArray | null = null;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(content)) !== null) {
    if (lastMatch) {
      const body = content.slice(
        lastMatch.index + lastMatch[0].length,
        match.index,
      );
      results.push([lastMatch[1], body]);
    }
    lastMatch = match;
  }

  // Last section
  if (lastMatch) {
    const body = content.slice(lastMatch.index + lastMatch[0].length);
    results.push([lastMatch[1], body]);
  }

  return results;
}

// ---------------------------------------------------------------------------
// Insert prompt blocks into .at source
// ---------------------------------------------------------------------------

/**
 * Insert or update `prompt { }` blocks in .at source text.
 *
 * For each extracted prompt:
 * 1. Find the `agent <id> {` block using regex
 * 2. Check if a `prompt { }` block already exists
 * 3. If exists: replace the content between the prompt braces
 * 4. If not: insert a new `prompt { ... }` block before the closing `}` of the agent
 */
function insertPromptBlocks(
  atSource: string,
  prompts: ExtractedPrompt[],
): string {
  let result = atSource;

  for (const { agentId, content } of prompts) {
    if (!content.trim()) continue;

    // Find agent block — must re-search each time since result mutates
    const agentPattern = new RegExp(
      `([ \\t]*)agent\\s+${escapeRegex(agentId)}\\s*\\{`,
      "m",
    );
    const agentMatch = agentPattern.exec(result);
    if (!agentMatch) continue;

    const baseIndent = agentMatch[1];
    const blockIndent = baseIndent + "  ";
    const contentIndent = blockIndent + "  ";

    // Find the agent block boundaries using brace counting
    const braceStart = agentMatch.index + agentMatch[0].length;
    let depth = 1;
    let pos = braceStart;
    while (pos < result.length && depth > 0) {
      if (result[pos] === "{") depth++;
      else if (result[pos] === "}") depth--;
      pos++;
    }
    const agentEnd = pos; // position after closing }
    const agentBody = result.slice(braceStart, agentEnd - 1);

    // Indent the content
    const indentedContent = content
      .split("\n")
      .map((line) => (line.trim() ? contentIndent + line : ""))
      .join("\n");

    // Check if prompt block already exists in this agent
    const promptBlockRe = /prompt\s*\{/m;
    const existingPrompt = promptBlockRe.exec(agentBody);

    if (existingPrompt) {
      // Replace existing prompt block content
      // Find the prompt { in the full result string
      const promptKeywordPos = braceStart + existingPrompt.index!;
      const promptBraceStart = result.indexOf("{", promptKeywordPos);
      let pDepth = 1;
      let pPos = promptBraceStart + 1;
      while (pPos < result.length && pDepth > 0) {
        if (result[pPos] === "{") pDepth++;
        else if (result[pPos] === "}") pDepth--;
        pPos++;
      }
      // pPos is now right after the closing } of the prompt block
      // Replace everything from after { to before } (inclusive of the })
      result =
        result.slice(0, promptBraceStart + 1) +
        "\n" +
        indentedContent +
        "\n" +
        blockIndent +
        "}" +
        result.slice(pPos);
    } else {
      // Insert new prompt block before the closing } of the agent
      // Find the position just before the agent's closing brace
      const closingBracePos = agentEnd - 1;
      const promptBlock = `\n${blockIndent}prompt {\n${indentedContent}\n${blockIndent}}\n`;
      result =
        result.slice(0, closingBracePos) +
        promptBlock +
        result.slice(closingBracePos);
    }
  }

  return result;
}

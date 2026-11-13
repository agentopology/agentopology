/**
 * Test helper (CX-5): Codex refuses a Claude model name, so a fixture written
 * for Claude Code gets a Codex model before it is scaffolded for Codex.
 */
export const CODEX_TEST_MODEL = "gpt-5.2";

/** The source with every `model: opus|sonnet|haiku|fable` replaced by a Codex model. */
export function codexSource(src: string): string {
  return src.replace(/\bmodel: (opus|sonnet|haiku|fable)\b/g, `model: ${CODEX_TEST_MODEL}`);
}

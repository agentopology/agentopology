/**
 * How often each top-level section of a topology may appear.
 *
 * The rule: no block is dropped without a message.
 *
 * - REPEATED: one block per named thing (`agent x { }`, `person y { }`), or a
 *   container the parser reads from every occurrence (`skills { }`). Write as
 *   many as you need.
 * - MERGED: `hooks { }` may be written more than once. Every block's hooks are
 *   used, in file order; a hook name used in two blocks is an error. Inside
 *   an agent, the first block is the agent's own; a second and later block
 *   joins the top-level hooks (where 0.11.4 put it).
 * - SINGLE: everything else. A second copy is a V23 warning that names it
 *   (only the first copy is used); never silent.
 * - CHILDREN: keywords that belong inside a container (`gate` in `gates`);
 *   at the top level they are V98 errors.
 *
 * A guard test checks that every top-level block the parser knows is in
 * exactly one of these lists, so a new section cannot fall between them.
 */

export const REPEATED_SECTIONS = ["agent", "action", "human", "group", "skill", "person", "skills"] as const;

export const MERGED_SECTIONS = ["hooks"] as const;

export const SINGLE_SECTIONS = [
  "meta", "orchestrator", "roles", "flow", "gates", "depth", "memory", "batch",
  "environments", "triggers", "settings", "mcp-servers", "metering", "context",
  "env", "providers", "schedule", "interfaces", "tools", "defaults", "schemas",
  "observability", "params", "interface", "checkpoint", "artifacts", "records",
  "machines", "extensions", "inventory", "needs", "islands",
] as const;

export const CHILD_KEYWORDS = ["gate", "hook", "tool", "job", "command", "level"] as const;

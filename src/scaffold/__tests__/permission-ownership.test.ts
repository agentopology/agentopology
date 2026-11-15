/**
 * Permission rules the .at wrote are owned through the scaffold manifest.
 *
 * A re-scaffold used to union `permissions.allow/ask/deny` with the file on
 * disk, so a rule removed from the .at stayed in settings.json: a removed
 * allow stayed granted. Owned rules the .at no longer declares are removed;
 * rules the user added by hand are never touched.
 *
 * These tests run the built CLI (`dist/cli/index.js scaffold`) in a temp dir.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const here = dirname(fileURLToPath(import.meta.url));
const CLI = resolve(here, "../../../dist/cli/index.js");

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(join(os.tmpdir(), "at-perm-own-"));
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

const topo = (settings: string) => `topology perms : [pipeline] {
  meta {
    version: "1.0.0"
    description: "permission ownership"
  }

  agent worker {
    description: "Does work"
    model: sonnet
    tools: [Read]
  }

  action intake {
    kind: inline
    description: "entry"
  }

  flow { intake -> worker }

  settings {
${settings}
  }
}
`;

const scaffold = (src: string) => {
  const f = join(root, "perms.at");
  fs.writeFileSync(f, src);
  const r = spawnSync("node", [CLI, "scaffold", f, "--target", "claude-code", "--output", root], {
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1" },
    timeout: 60_000,
  });
  expect(r.status, r.stderr + r.stdout).toBe(0);
  return r;
};

const settingsPath = () => join(root, ".claude/settings.json");
const perms = (): Record<string, string[]> => JSON.parse(fs.readFileSync(settingsPath(), "utf8")).permissions ?? {};
const count = (list: string[] | undefined, rule: string) => (list ?? []).filter((r) => r === rule).length;

/** Hand-add a rule to settings.json, the way a user would. */
const userAdds = (list: "allow" | "ask" | "deny", rule: string) => {
  const doc = JSON.parse(fs.readFileSync(settingsPath(), "utf8"));
  doc.permissions = doc.permissions ?? {};
  doc.permissions[list] = [...(doc.permissions[list] ?? []), rule];
  fs.writeFileSync(settingsPath(), JSON.stringify(doc, null, 2) + "\n");
};

describe("[P-OWN] permission rules the .at wrote are owned through the manifest", () => {
  it("[P-OWN] a dropped allow is removed, a kept one stays once, the user's rule stays", () => {
    scaffold(topo(`    allow: ["Bash(npm test:*)", "Read"]`));
    expect(perms().allow).toEqual(["Bash(npm test:*)", "Read"]);
    userAdds("allow", "Bash(git status:*)");

    scaffold(topo(`    allow: ["Read"]`));
    const allow = perms().allow;
    expect(count(allow, "Bash(npm test:*)")).toBe(0);
    expect(count(allow, "Read")).toBe(1);
    expect(count(allow, "Bash(git status:*)")).toBe(1);
  });

  it("[P-OWN] a dropped deny and a dropped ask are removed; the user's deny and ask stay", () => {
    scaffold(topo(`    deny: ["Bash(rm -rf:*)", "WebFetch"]\n    ask: ["Bash(git push:*)", "Write"]`));
    userAdds("deny", "Bash(curl:*)");
    userAdds("ask", "Edit");

    scaffold(topo(`    deny: ["WebFetch"]\n    ask: ["Write"]`));
    const p = perms();
    expect(count(p.deny, "Bash(rm -rf:*)")).toBe(0);
    expect(count(p.deny, "WebFetch")).toBe(1);
    expect(count(p.deny, "Bash(curl:*)")).toBe(1);
    expect(count(p.ask, "Bash(git push:*)")).toBe(0);
    expect(count(p.ask, "Write")).toBe(1);
    expect(count(p.ask, "Edit")).toBe(1);
  });

  it("[P-OWN] a rule moved from allow to deny leaves allow and is in deny once", () => {
    scaffold(topo(`    allow: ["Bash(git push:*)", "Read"]`));
    scaffold(topo(`    allow: ["Read"]\n    deny: ["Bash(git push:*)"]`));
    const p = perms();
    expect(count(p.allow, "Bash(git push:*)")).toBe(0);
    expect(count(p.deny, "Bash(git push:*)")).toBe(1);
    expect(count(p.allow, "Read")).toBe(1);
  });

  it("[P-OWN] dropping every rule removes the owned ones and keeps the user's", () => {
    scaffold(topo(`    allow: ["Bash(npm test:*)"]`));
    userAdds("allow", "Bash(git status:*)");
    scaffold(topo(`    sandbox: true`));
    expect(perms().allow).toEqual(["Bash(git status:*)"]);
  });

  it("[P-OWN] the manifest records the owned rules on the settings.json entry", () => {
    scaffold(topo(`    allow: ["Bash(npm test:*)", "Read"]\n    deny: ["WebFetch"]`));
    const manifest = JSON.parse(fs.readFileSync(join(root, ".claude/.scaffold-manifest.json"), "utf8"));
    expect(manifest.files[".claude/settings.json"].permissions).toEqual({
      allow: ["Bash(npm test:*)", "Read"],
      deny: ["WebFetch"],
    });
  });

  it("[P-OWN] a rule the user had before the first scaffold stays the user's when the .at drops it", () => {
    fs.mkdirSync(join(root, ".claude"), { recursive: true });
    fs.writeFileSync(settingsPath(), JSON.stringify({ permissions: { allow: ["Read"] } }, null, 2) + "\n");
    scaffold(topo(`    allow: ["Read", "Bash(npm test:*)"]`));
    scaffold(topo(`    allow: ["Grep"]`));
    const allow = perms().allow;
    expect(count(allow, "Read")).toBe(1);
    expect(count(allow, "Bash(npm test:*)")).toBe(0);
    expect(count(allow, "Grep")).toBe(1);
  });

  it("[P-OWN] an old manifest without the record removes nothing on the first re-scaffold", () => {
    scaffold(topo(`    allow: ["Bash(npm test:*)", "Read"]`));
    // A manifest written by 0.11.1: no permissions record on the entry.
    const mPath = join(root, ".claude/.scaffold-manifest.json");
    const manifest = JSON.parse(fs.readFileSync(mPath, "utf8"));
    delete manifest.files[".claude/settings.json"].permissions;
    fs.writeFileSync(mPath, JSON.stringify(manifest, null, 2) + "\n");
    userAdds("allow", "Bash(git status:*)");

    scaffold(topo(`    allow: ["Read"]`));
    const allow = perms().allow;
    expect(count(allow, "Bash(npm test:*)")).toBe(1);
    expect(count(allow, "Read")).toBe(1);
    expect(count(allow, "Bash(git status:*)")).toBe(1);
    // From here the record exists: what the .at generates now is owned.
    const after = JSON.parse(fs.readFileSync(mPath, "utf8"));
    expect(after.files[".claude/settings.json"].permissions).toEqual({ allow: ["Read"] });
  });

  it("[P-OWN] an old manifest with a stale allow left by the earlier bug: a warning names it, the file is unchanged", () => {
    // 0.11.1 behaviour: the .at dropped Bash(npm test:*), the union kept it, the manifest has no record.
    scaffold(topo(`    allow: ["Bash(npm test:*)", "Read"]\n    ask: ["Bash(git push:*)"]`));
    const mPath = join(root, ".claude/.scaffold-manifest.json");
    const manifest = JSON.parse(fs.readFileSync(mPath, "utf8"));
    delete manifest.files[".claude/settings.json"].permissions;
    fs.writeFileSync(mPath, JSON.stringify(manifest, null, 2) + "\n");
    const before = fs.readFileSync(settingsPath(), "utf8");

    const r = scaffold(topo(`    allow: ["Read"]`));
    const out = r.stdout + r.stderr;
    expect(fs.readFileSync(settingsPath(), "utf8")).toBe(before);
    expect(out).toContain("may have been written by an earlier scaffold");
    expect(out).toContain("remove it if you did not add it by hand");
    expect(out).toMatch(/allow\s+Bash\(npm test:\*\)/);
    expect(out).toMatch(/ask\s+Bash\(git push:\*\)/);
    // A rule the .at still declares is not named.
    expect(out).not.toMatch(/allow\s+Read\b/);

    // The record now exists: the next run names nothing.
    const again = scaffold(topo(`    allow: ["Read"]`));
    expect(again.stdout + again.stderr).not.toContain("may have been written by an earlier scaffold");
  });

  it("[P-OWN] a current manifest gives no stale-rule warning, even with a user rule present", () => {
    scaffold(topo(`    allow: ["Read"]`));
    userAdds("allow", "Bash(git status:*)");
    const r = scaffold(topo(`    allow: ["Read"]`));
    expect(r.stdout + r.stderr).not.toContain("may have been written by an earlier scaffold");
  });
});

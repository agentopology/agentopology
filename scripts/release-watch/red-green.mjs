#!/usr/bin/env node
// The red-green gate: proves a planted test was red before its fix.
// It clones the repo, runs the test command at the test's own commit (must fail),
// then at HEAD (must pass). It never touches the repo it was given.
//
//   node scripts/release-watch/red-green.mjs --repo <path|url|bundle> \
//        --test-commit <ref> --cmd "<test command>" [--head <ref>] [--json]
//
// Exit 0: red at the test commit, green at HEAD.
// Exit 1: never red (passed at its own commit), or still red at HEAD.
// Exit 2: bad arguments, an unknown ref, or a failed clone.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const args = process.argv.slice(2);
const opt = (n) => { const i = args.indexOf(`--${n}`); return i < 0 ? undefined : args[i + 1]; };
const json = args.includes("--json");
const repo = opt("repo"), testRef = opt("test-commit"), cmd = opt("cmd"), headRef = opt("head") ?? "HEAD";
const die = (msg) => { console.error(`red-green: ${msg}`); process.exit(2); };
if (!repo || !testRef || !cmd) die("need --repo, --test-commit and --cmd");

const git = (cwd, ...a) => spawnSync("git", a, { cwd, encoding: "utf8", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
const work = fs.mkdtempSync(path.join(os.tmpdir(), "red-green-"));
const clone = path.join(work, "repo");
try {
  const c = git(work, "clone", "--quiet", "--no-checkout", repo, clone);
  if (c.status !== 0) die(`cannot clone ${repo}: ${c.stderr.trim()}`);

  // Resolve both refs first: checking out the test commit moves the clone's HEAD.
  const resolveRef = (ref) => {
    const sha = git(clone, "rev-parse", "--verify", "--quiet", `${ref}^{commit}`);
    if (sha.status !== 0) die(`unknown ref ${ref}`);
    return sha.stdout.trim();
  };
  const testSha = resolveRef(testRef), headSha = resolveRef(headRef);

  const at = (ref, full) => {
    const co = git(clone, "checkout", "--quiet", "--force", "--detach", full);
    if (co.status !== 0) die(`cannot check out ${ref}: ${co.stderr.trim()}`);
    const r = spawnSync("sh", ["-c", cmd], { cwd: clone, encoding: "utf8", timeout: 600_000 });
    return { ref, sha: full.slice(0, 12), exit: r.status ?? 1 };
  };

  const red = at(testRef, testSha);
  const green = at(headRef, headSha);
  const verdict = red.exit === 0 ? "never-red" : green.exit !== 0 ? "still-red" : "red-then-green";
  if (json) console.log(JSON.stringify({ verdict, testCommit: red, head: green }));
  else {
    console.log(`test commit ${red.sha}: exit ${red.exit}`);
    console.log(`HEAD ${green.sha}: exit ${green.exit}`);
    if (verdict === "never-red") console.log("never red: the test passes at its own commit, so it proves nothing about the fix");
    if (verdict === "still-red") console.log("still red: the test fails at HEAD, so the fix is not in");
    if (verdict === "red-then-green") console.log("ok: red before the fix, green after");
  }
  process.exitCode = verdict === "red-then-green" ? 0 : 1;
} finally {
  fs.rmSync(work, { recursive: true, force: true });
}

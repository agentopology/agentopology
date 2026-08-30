# Using the `antigravity` Binding in Other Projects

This binding is a local change to this repo — it has not been published to
npm yet. Until it is, here's how to scaffold it into any project.

---

## Option A: run from source (no build needed)

```bash
cd ~/Development/agentopology
npx tsx src/cli/index.ts scaffold /path/to/project/your-topology.at \
  --target antigravity \
  --output /path/to/project
```

This writes `.agents/workflows/<topology-name>-autopilot.md` directly into
`/path/to/project`. Works immediately, no build step, since `tsx` runs the
TypeScript source directly.

---

## Option B: build once, then run the compiled CLI

```bash
cd ~/Development/agentopology
npm run build
node dist/cli/index.js scaffold /path/to/project/your-topology.at \
  --target antigravity \
  --output /path/to/project
```

> **Known issue:** `npm run build` currently fails with `Cannot find module
> 'node:fs'` / `Cannot find name 'process'` errors — this repo is missing
> `@types/node` as a devDependency (pre-existing, unrelated to the antigravity
> binding). If `npm run build` fails, use **Option A** instead.

---

## Option C: install a global `agentopology` command (recommended for repeated use)

Run once, from the agentopology repo:

```bash
cd ~/Development/agentopology
npm link
```

This puts an `agentopology` binary on your `PATH`. From then on, in any
project directory:

```bash
agentopology scaffold your-topology.at --target antigravity --output .
```

No more `cd`-ing into the agentopology repo each time. Re-run `npm link`
after pulling new changes to this repo if `npm run build` is fixed and used
as the entry point (currently `npm link` still needs Option A's `tsx` path
internally until the build issue above is resolved).

---

## Quick reference

| Command | What it does |
|---|---|
| `agentopology validate <file>.at` | Check the topology against all 82 rules |
| `agentopology scaffold <file>.at --target antigravity --output <dir>` | Generate `.agents/workflows/<name>-autopilot.md` |
| `agentopology visualize <file>.at` | Open an interactive graph of the topology |
| `agentopology targets` | List all available binding targets |

See [`antigravity-mapping.md`](./antigravity-mapping.md) for exactly which
`.at` primitives translate cleanly vs. as lossy prose vs. not at all.

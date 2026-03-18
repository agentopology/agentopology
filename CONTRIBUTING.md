# Contributing to AgentTopology

Thanks for your interest in contributing. AgentTopology is an open standard — the more people contribute, the stronger it gets.

## Quick Start

```bash
git clone https://github.com/nadavnaveh/agentopology.git
cd agentopology
npm install
npm run test        # Run tests (must pass before submitting a PR)
npm run typecheck   # TypeScript type checking
```

## What You Can Contribute

### Open to Everyone

- **New examples** — Write `.at` files for common use cases (RAG, customer support, CI/CD, etc.)
- **Binding improvements** — Improve any of the 7 CLI bindings (Claude Code, OpenClaw, Codex, Cursor, Gemini CLI, Copilot, Kiro)
- **Tests** — Add test coverage for bindings, parser edge cases, or CLI commands
- **CLI features** — New flags, output formats, better error messages
- **Visualizer improvements** — Better graph layouts, new node rendering, interactivity
- **Documentation** — Tutorials, guides, cheat sheets
- **Editor plugins** — Syntax highlighting for VS Code, JetBrains, Vim, etc.

### Requires an RFC (open an issue first)

- Grammar spec changes (new keywords, syntax modifications)
- AST type changes (adding/modifying fields in `src/parser/ast.ts`)
- Validation rules (new rules or changing existing ones)
- New node types or edge attributes
- Changes to the `BindingTarget` interface
- Reserved keywords list modifications

We protect these areas to keep the language stable and backward-compatible. Open an issue with your proposal and we'll discuss it.

## Pull Request Process

1. **Fork and branch** — Create a feature branch from `main`
2. **Write tests** — Every change should have tests. Run `npm run test` to verify
3. **Type check** — Run `npm run typecheck` to ensure zero TypeScript errors
4. **Keep it focused** — One feature or fix per PR. Small PRs get reviewed faster
5. **Write a clear description** — Explain what and why, not just how

## Code Style

- TypeScript strict mode
- No `any` types without justification
- Prefer explicit return types on exported functions
- Use JSDoc comments for public APIs
- Follow existing patterns in the codebase

## Adding a New Binding

Bindings transform a parsed `TopologyAST` into platform-specific files. To add one:

1. Create `src/bindings/your-platform.ts`
2. Implement the `BindingTarget` interface
3. Register it in `src/bindings/index.ts`
4. Add tests in `src/bindings/__tests__/bindings.test.ts`
5. Update `README.md` platform table
6. Add validation against real-world configs from the target platform

See existing bindings (especially `claude-code.ts` and `cursor.ts`) as reference implementations.

## Adding a New Example

1. Create `examples/your-example.at`
2. Make sure it parses: `npx tsx src/cli/index.ts validate examples/your-example.at`
3. Add a description comment at the top of the file
4. Test scaffolding: `npx tsx src/cli/index.ts scaffold examples/your-example.at --target claude-code --dry-run`

## Reporting Bugs

Open an issue with:
- The `.at` file that triggers the bug (minimal reproduction)
- The command you ran
- Expected vs actual output
- Your Node.js version (`node --version`)

## Questions?

Open a [Discussion](https://github.com/nadavnaveh/agentopology/discussions) or reach out in issues. We're friendly.

## License

By contributing, you agree that your contributions will be licensed under the Apache 2.0 License.

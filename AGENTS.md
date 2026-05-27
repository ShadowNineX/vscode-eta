# AGENTS.md

Guidance for coding agents working in this repository.

## Project Overview

This is a VS Code extension that provides language support for Eta templates (`.eta`): syntax highlighting, snippets, completions, hover help, diagnostics, and LSP-powered TypeScript IntelliSense inside Eta tags.

The extension has two main runtime pieces:

- `src/extension.ts` is the VS Code extension host entry point. It registers completion, hover, diagnostics, and starts the language client.
- `src/server.ts` is the language-server entry point. It owns LSP wiring, open-document state, virtual file cache, and TypeScript language-service lifecycle.
- `src/etaScanner.ts` parses Eta tag ranges and tag content, including multi-line tags and delimiter-like text inside strings/comments.
- `src/virtualDocument.ts` builds the virtual TypeScript content used for completions/hovers and owns the fixed preamble.
- `src/typeInference.ts` scans TS/JS workspace files for Eta render calls and infers structural `it` types.
- `src/position.ts` contains offset and tag-containment helpers.
- `src/lspKind.ts` maps TypeScript completion kinds to LSP completion kinds.

Other important assets:

- `syntaxes/eta.tmLanguage.json` defines TextMate grammar highlighting.
- `snippets/eta.json` defines Eta snippets contributed by the extension.
- `language-configuration.json` defines brackets, comments, auto-closing pairs, folding, and word patterns.
- `templates/` contains Eta fixture templates used by tests.
- `demo/` is a sample workspace used to exercise type inference from real Eta render calls.
- `out/` is generated compiler output and should not be edited directly.

## Commands

Use Bun from the repository root:

```sh
bun run compile
bun run test
bun run test:coverage
bun run test:ui
```

Notes:

- `bun run test` runs the package `test` script, which uses `vitest run`.
- `bun run compile` runs `tsc -p ./` and emits to `out/`.
- Tests run in the Node environment via `vitest.config.ts`.
- The lockfile is `bun.lock`. Use Bun for installs, script execution, and lockfile updates unless explicitly asked otherwise.

## Development Rules

- Keep source edits in `src/`, syntax edits in `syntaxes/`, snippets in `snippets/`, fixtures in `templates/`, and demo-only examples in `demo/`.
- Do not hand-edit `out/`; regenerate it with `bun run compile`.
- Do not commit or rely on `node_modules/`, coverage output, `.vitest/`, `.vsix`, `dist/`, or other ignored generated artifacts.
- Preserve strict TypeScript compatibility. `tsconfig.json` uses `strict: true`, CommonJS modules, ES2020 target, declarations, and source maps.
- Prefer focused changes that match the existing style: double quotes, semicolons, explicit exported helpers where tests need direct coverage.
- When changing Eta tag parsing, be careful with character and line offsets. The language server intentionally pads non-TypeScript template text with spaces so TypeScript diagnostics/completions map back to the original Eta source.
- Keep `PREAMBLE_LINE_COUNT` accurate if the virtual TypeScript preamble changes. Tests depend on the fixed line offset.
- Avoid widening type-inference behavior casually. `src/typeInference.ts` deliberately expands render-call data into self-contained structural `it` types and prevents type bleed between templates.

## Testing Guidance

Run the most relevant tests after changes:

- Parser, virtual-file, type-inference, LSP completion/hover changes: `bun run test`.
- Snippet, grammar, or template fixture changes: `bun run test`, and consider manual VS Code extension testing.
- Compile-only/package-surface changes: `bun run compile`.

Important test files:

- `tests/etaScanner.test.ts` covers Eta tag opener/content parsing and tag-range detection.
- `tests/virtualDocument.test.ts` covers virtual Eta-to-TypeScript content and preamble behavior.
- `tests/position.test.ts` covers offset conversion and cursor-in-tag detection.
- `tests/lspKind.test.ts` covers TypeScript completion-kind to LSP-kind mapping.
- `tests/typeInference.test.ts` covers `it` type inference, workspace scanning, and demo integration.
- `tests/server.test.ts` smoke-tests the language-server entrypoint wiring.
- `tests/providers.test.ts` covers provider-style parsing and diagnostic logic.
- `tests/templates.test.ts` validates fixture templates and common Eta patterns.
- `tests/extension.test.ts` uses mocked VS Code APIs for extension-host behavior.

When adding a new Eta language feature, add or update fixture coverage in `templates/` when useful, and update tests near the behavior being changed.

## VS Code Extension Packaging

`package.json` contributes:

- Language id `eta` for `.eta` files.
- Grammar at `syntaxes/eta.tmLanguage.json`.
- Snippets at `snippets/eta.json`.
- Extension main file `./out/extension.js`.

`.vscodeignore` excludes TypeScript sources and includes compiled `out/`, so compile before packaging or prepublish.

## Versioning and Changelog

- When changing the `version` field in `package.json`, update `CHANGELOG.md` in the same change.
- Add the new changelog entry above older versions and summarize user-visible fixes, features, packaging changes, and important developer workflow changes.
- Use recent git history to describe what changed since the previous version instead of guessing.
- Keep version notes concise and avoid listing unrelated internal churn.

## Manual QA

For interactive testing, open the repository or `demo/` in VS Code after compiling. Useful checks:

- `.eta` files highlight correctly.
- Typing inside `<% ... %>` offers Eta built-ins and TypeScript completions.
- Hover over helpers such as `layout`, `include`, `block`, `capture`, `output`, and `it`.
- Broken fixture-like templates show diagnostics for empty, unclosed, or mismatched tags.
- Demo templates infer distinct `it` types without leaking fields between templates.

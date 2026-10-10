# Changelog

## 0.4.0

- Added a flat Eta monogram icon for the VS Code Marketplace and project branding.
- Fixed manifest building and workspace ownership through Windows short-path aliases.
- Added a trusted-build manifest builder and CLI for runtime routes, custom loaders, plugins and generated/transformed templates, with hash freshness and validated output.
- Added bounded imported render wrappers, parameterized factories and paired finite-record inference; replaced missing-evidence `any` with actionable `unknown` diagnostics.
- Fixed untitled-document activation and stale/nested manifest ownership, including watcher-excluded inputs and transformed syntax outside Eta tags.
- Preserved dictionary index signatures, public class members and readonly data; fixed linked workspace paths, startup-stale diagnostics, ESM dependency freshness and manifest output collisions.
- Reduced inference/server complexity and addressed deprecated API, promise and expression warnings reported by SonarQube.
- Expanded Eta recognition across TS/JS module formats, browser/Deno imports, constructor aliases, bound methods, finite template names, simple factories and file-backed `renderString` calls.
- Fixed nested/referenced project discovery, template compiler-context ownership, config/source refresh and same-basename type isolation. Preserved self-contained callback types, including rest parameters, overloads and generics.
- Updated development and LSP dependencies while retaining the compatible TypeScript compiler API and minimum VS Code API types.
- Fixed Windows LSP test teardown, restored the extension-host test source, made coverage run once, and added Windows/Linux CI with native VS Code tests and inference regression coverage.

## 0.3.0

- Aligned scanner and virtual-document behavior with Eta 4.6 multiline openers, adjacent-tag boundaries, generated function scope, async templates, render options, and JavaScript runtime syntax.
- Hardened render inference with Eta symbol provenance, project-aware excluded-file analysis, sound multi-call unions, include/layout override precedence, valid quoted properties, aliases, destructuring, configured instances, and `loadTemplate` registrations.
- Scoped block navigation to related layout trees, retained explicit child-data definitions, added `.mts`/`.cts`/`.mjs`/`.cjs` scanning, handled workspace-folder changes, and released closed virtual documents.
- Normalized live configuration updates and modeled `async`, automatic escape/filter/trim behavior, whitespace removal, and safe custom-tag language metadata.
- Consolidated completion and hover in the language server, embedded VS Code's standard HTML/JavaScript TextMate scopes, supported Eta tags inside HTML attributes, and fixed the async block snippet.
- Added Eta-runtime differential tests, real TextMate tokenization, bundled stdio LSP smoke coverage, and a real VS Code extension-host suite for production providers and snippet expansion.
- Added a strictly validated, hash-fresh `.eta-language-support.json` bridge for runtime-derived options, transformed virtual TypeScript, source maps, data definitions, diagnostics, template names, relationships, and cross-file symbol navigation without executing project code.
- Expanded language-server semantic tokens from custom-prefix markers to JavaScript classification inside every configured JavaScript tag, including dynamically selected delimiters and manifest-mapped transformed code.

## 0.2.1

- Migrated extension bundling from tsup to tsdown while preserving CommonJS entry files and packaged TypeScript standard-library declarations.
- Removed redundant language-server re-exports and consolidated duplicate request-position, source-location, and logger logic.
- Fixed VS Code language-configuration validation by using the current object form for line comments.

## 0.2.0

- Added Ctrl-click and Go to Definition for Eta-local variables and inferred render data, including nested properties, arrays, layouts, custom `varName`, and `useWith`.

## 0.1.3

- Fixed packaged-extension TypeScript IntelliSense by copying TypeScript standard library declarations into `out/` during the build.
- Automated TypeScript lib copying through `tsup` so `compile`, tests, `vsce package`, and `vsce publish` all use the same runtime output.
- Fixed array type hovers in Eta templates, including `it.tags` resolving as `string[]` instead of `Record<string, unknown>`.
- Fixed virtual TypeScript generation for multiple Eta output tags on the same line by safely separating output expressions.
- Added regression coverage for array properties and string literal union methods such as `it.status.toUpperCase()`.

## 0.1.2

- Minified bundled extension output to reduce the generated language-server bundle size.
- Kept the packaged extension bundled instead of shipping runtime `node_modules`.

## 0.1.1

- Renamed the Marketplace package to `eta-language-support`.
- Rebranded the Marketplace display name to `Eta IntelliSense`.
- Switched the publisher metadata to `ShadowNine`.
- Added GitHub issue templates, pull request template, and a VSIX build workflow.
- Added Codecov coverage upload support in CI.
- Tightened package ignore rules so generated coverage, local VSIX files, GitHub metadata, demos, tests, and source files are not bundled.
- Increased the timeout for the heavy workspace-analysis integration test under coverage.

## 0.1.0

- Initial Eta language support for `.eta` files.
- Added syntax highlighting, snippets, hover help, diagnostics, and completions.
- Added TypeScript-powered language features inside Eta tags.
- Added inferred `it` types from Eta render calls in TypeScript and JavaScript files.
- Added layout type propagation for templates using `layout(...)`.
- Added support for Eta language options such as custom delimiters, parse prefixes, `customTags` prefixes, `varName`, `useWith`, `functionHeader`, and `outputFunctionName`.

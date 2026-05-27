# Changelog

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

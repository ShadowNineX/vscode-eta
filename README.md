<div align="center">

# ⚡ Eta IntelliSense

### Typed editor tooling for fast, delightful `.eta` templates in VS Code.

[![Build VSIX](https://img.shields.io/github/actions/workflow/status/ShadowNineX/vscode-eta/build-vsix.yml?branch=main&label=build%20vsix&style=for-the-badge)](https://github.com/ShadowNineX/vscode-eta/actions/workflows/build-vsix.yml)
[![Coverage](https://img.shields.io/codecov/c/github/ShadowNineX/vscode-eta?style=for-the-badge&logo=codecov&logoColor=white)](https://codecov.io/gh/ShadowNineX/vscode-eta)
[![Version](https://img.shields.io/github/package-json/v/ShadowNineX/vscode-eta?style=for-the-badge&color=7c3aed)](package.json)
[![License](https://img.shields.io/github/license/ShadowNineX/vscode-eta?style=for-the-badge&color=22c55e)](LICENSE)
[![Bun](https://img.shields.io/badge/bun-powered-000000?style=for-the-badge&logo=bun&logoColor=white)](https://bun.sh/)
[![Eta](https://img.shields.io/badge/eta-v4-ff477e?style=for-the-badge)](https://eta.js.org/)

`Eta IntelliSense` brings syntax highlighting, snippets, diagnostics, hover docs, completions, and TypeScript-powered IntelliSense to VS Code templates.

</div>

---

## ✨ Features

- 🎨 Syntax highlighting for Eta tags, embedded JavaScript, HTML, strings, and comments.
- 🧩 Snippets for common Eta patterns.
- 🧠 TypeScript completions, hovers, signature help, references, and rename inside Eta tags.
- 🔍 Go to Definition for local/inferred data, include/layout paths, and named blocks.
- ✅ Mapped TypeScript diagnostics plus precise empty, unclosed-tag, string, and block-comment diagnostics.
- ⚡ Eta-helper and template-path completions for includes and layouts.
- 🧬 Collision-safe template data inference from render calls, includes, and layouts.
- 🛠 Workspace `tsconfig.json`/`jsconfig.json`, multiple roots, and configurable Eta delimiters, parse prefixes, `customTags`, `varName`, `useWith`, `functionHeader`, and `outputFunctionName`.
- Generated `.eta-language-support.json` manifests for authoritative runtime-derived configuration, virtual code, data types, diagnostics, template names, and symbol navigation without executing project code in VS Code.

## 🚀 Quick Taste

```eta
<% layout("./base") %>

<h1><%= it.title %></h1>

<% it.items.forEach((item) => { %>
  <article>
    <h2><%= item.name %></h2>
    <%~ item.descriptionHtml %>
  </article>
<% }) %>
```

And in TypeScript:

```ts
import { Eta } from "eta";

const eta = new Eta({ views: "./views" });

eta.render("catalog", {
  title: "Featured Products",
  items: [
    {
      name: "Eta Hoodie",
      descriptionHtml: "<strong>Soft, fast, typed.</strong>",
    },
  ],
});
```

Inside `views/catalog.eta`, the language server can infer:

```ts
{
  title: string;
  items: {
    name: string;
    descriptionHtml: string;
  }[];
}
```

## 🧠 Typed Templates

The language server scans workspace TypeScript and JavaScript files for Eta render calls, then maps render data back to matching `.eta` files.

Supported inference sources:

- Eta v3/v4 named template calls: `render(...)` and `renderAsync(...)`.
- Legacy Eta v2 file calls: `renderFile(...)` and `renderFileAsync(...)`.
- String literals and no-substitution template literals on recognized Eta instances, including `withConfig(...)`.
- Programmatic templates named with `@`, such as `eta.render("@header", data)`.
- Inherited and explicit data passed through `include(...)` and `layout(...)`, including layout `body` content.

`renderString(...)` and `renderStringAsync(...)` are treated as inline Eta source, so they are not mapped to `.eta` template files.

## ⚙️ Eta Configuration

Eta is flexible, so the extension can mirror common runtime options through VS Code settings:

```json
{
  "eta.tags.open": "{{",
  "eta.tags.close": "}}",
  "eta.parse.interpolate": ":",
  "eta.parse.raw": "!",
  "eta.customTags": ["#"],
  "eta.customTagTypes": { "@": "javascript" },
  "eta.varName": "data",
  "eta.useWith": false,
  "eta.outputFunctionName": "print",
  "eta.async": true,
  "eta.autoEscape": true,
  "eta.autoFilter": false,
  "eta.autoTrim": [false, "nl"],
  "eta.rmWhitespace": false
}
```

These settings do not execute your Eta config. They tell the editor how to parse templates and build the virtual TypeScript document used for completions, hover, and diagnostics.

### Settings Reference

| Setting | Default | What it does |
| --- | --- | --- |
| `eta.tags.open` | `<%` | Opening delimiter for Eta tags. |
| `eta.tags.close` | `%>` | Closing delimiter for Eta tags. |
| `eta.parse.exec` | `""` | Prefix for JavaScript execution tags. |
| `eta.parse.interpolate` | `=` | Prefix for escaped output tags. |
| `eta.parse.raw` | `~` | Prefix for raw output tags. |
| `eta.customTags` | `[]` | Custom tag prefixes handled by your Eta runtime. |
| `eta.customTagTypes` | `{}` | Declares custom prefixes as `javascript` or opaque `text` without executing plugin code. |
| `eta.varName` | `it` | Name of the template data variable. |
| `eta.useWith` | `false` | Exposes top-level data properties as variables. |
| `eta.functionHeader` | `""` | Extra declarations injected into the virtual template file. |
| `eta.outputFunctionName` | `output` | Name of the Eta output helper function. |
| `eta.async` | `false` | Models the template as an async function. |
| `eta.autoEscape` | `true` | Mirrors Eta's automatic XML-escaping mode. |
| `eta.autoFilter` | `false` | Mirrors Eta's automatic interpolation-filter mode. |
| `eta.autoTrim` | `[false, "nl"]` | Mirrors Eta's automatic before/after trim modes. |
| `eta.rmWhitespace` | `false` | Mirrors Eta's global whitespace-removal mode. |

The language server can also detect simple inline configs like `new Eta({ tags: ["{{", "}}"], varName: "data" })` and `eta.configure({ ... })` near render calls.

### Generated Runtime Manifest

Static analysis cannot resolve values produced by arbitrary application code or Eta plugins. A trusted project build step can bridge those results by writing `.eta-language-support.json` at the workspace root. The extension only validates and reads this file; it never imports the generator, Eta config, application modules, or plugin code.

VS Code validates this filename against [`schemas/eta-language-support.schema.json`](schemas/eta-language-support.schema.json). Manifest version `1` contains:

- `inputs`: every source/config file used to generate the manifest, with a lowercase SHA-256 hash;
- `templates`: exact template hashes plus normalized Eta options, the structural data type, data-definition locations, resolution settings, related templates, generated diagnostics, and transformed virtual TypeScript;
- `virtualDocument.mappings`: non-overlapping source-to-virtual offset segments used by completion, hover, diagnostics, definition, references, rename, signature help, and semantic tokens;
- `templateNames`: runtime-computed names and their resolved template/definition locations;
- `symbols`: stable cross-file occurrence groups for definitions, references, and rename.

All paths are normalized, workspace-relative POSIX paths. The loader rejects unknown fields, path traversal, symlink escapes, malformed types, invalid or overlapping ranges, unsupported versions, oversized files, and ambiguous symbol ownership. It also verifies every declared input and template hash. If the file is missing, invalid, stale, or does not list the open template, the language server safely falls back to its static analysis for that template.

Generate the file from your own trusted build or development process after the runtime configuration and plugins have produced their final template code. Regenerate it whenever an input or template changes. Do not place secrets or runtime values in the manifest: its contents are ordinary workspace data and may be packaged or committed.


## 📦 Demos

The `demo/` folder contains a standalone Eta workspace with typed render calls and matching templates. Open it in VS Code to try the extension against several usage patterns:

- `quickstart-file-render`
- `layouts-and-blocks`
- `partials-and-helpers`
- `async-render`
- `config-options`
- `api-surface`
- `syntax-edge-cases`

## 🏗 Development

This repository uses Bun.

```sh
bun install
bun run compile
bun run watch
bun run test
```

Useful scripts:

- `bun run compile` type-checks and bundles the extension into `out/` with `tsup`.
- `bun run watch` runs TypeScript in watch mode.
- `bun run test` compiles and runs the Vitest suite.
- `bun run test:ui` opens the Vitest UI.
- `bun run test:coverage` runs coverage.

## 🗂 Project Structure

```text
src/
  extension.ts        VS Code extension entrypoint and client-side providers
  server.ts           Language server entrypoint
  etaConfig.ts        Shared Eta language option defaults and normalization
  etaManifest.ts      Strict generated-manifest loader and source maps
  semanticTokens.ts   Mapped JavaScript semantic token classification
  etaScanner.ts       Eta tag scanner
  virtualDocument.ts  Eta-to-TypeScript virtual document builder
  typeInference.ts    Workspace render-call analysis and `it` type inference
  position.ts         Position and offset helpers
  lspKind.ts          TypeScript-to-LSP kind mapping
  logging.ts          Shared extension/server logging helpers

tests/                Vitest tests
syntaxes/             TextMate grammar
snippets/             Eta snippets
templates/            Syntax fixtures
demo/                 Demo workspace and scenario examples
```

## 📚 Eta Docs

- [Eta](https://eta.js.org/)
- [Eta v4 Quickstart](https://eta.js.org/docs/4.x.x/intro/quickstart)
- [Template Syntax](https://eta.js.org/docs/4.x.x/syntax/template-syntax)
- [Layouts and Blocks](https://eta.js.org/docs/4.x.x/syntax/layouts-and-blocks)
- [Helpers](https://eta.js.org/docs/4.x.x/syntax/helpers)
- [Configuration Options](https://eta.js.org/docs/4.x.x/api/configuration)

## 🤝 Contributors

<a href="https://github.com/ShadowNineX/vscode-eta/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=ShadowNineX/vscode-eta" alt="Contributors" />
</a>

Made with [contrib.rocks](https://contrib.rocks).

## 📄 License

[MIT](LICENSE)

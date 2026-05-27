<div align="center">

# ⚡ Eta for VS Code

### Rich language support for fast, typed, delightful `.eta` templates.

[![Build VSIX](https://img.shields.io/github/actions/workflow/status/ShadowNineX/vscode-eta/build-vsix.yml?branch=main&label=build%20vsix&style=for-the-badge)](https://github.com/ShadowNineX/vscode-eta/actions/workflows/build-vsix.yml)
[![Version](https://img.shields.io/github/package-json/v/ShadowNineX/vscode-eta?style=for-the-badge&color=7c3aed)](package.json)
[![License](https://img.shields.io/github/license/ShadowNineX/vscode-eta?style=for-the-badge&color=22c55e)](LICENSE)
[![Bun](https://img.shields.io/badge/bun-powered-000000?style=for-the-badge&logo=bun&logoColor=white)](https://bun.sh/)
[![Eta](https://img.shields.io/badge/eta-v4-ff477e?style=for-the-badge)](https://eta.js.org/)

`Eta` brings syntax highlighting, snippets, diagnostics, hover docs, completions, and TypeScript-powered IntelliSense to VS Code templates.

</div>

---

## ✨ Features

- 🎨 Syntax highlighting for Eta tags, embedded JavaScript, HTML, strings, and comments.
- 🧩 Snippets for common Eta patterns.
- 🧠 TypeScript language features inside Eta tags.
- 🔍 Hover documentation for Eta helpers and tags.
- ✅ Diagnostics for unclosed and empty Eta tags.
- ⚡ Completions for `layout`, `include`, `includeAsync`, `block`, `blockAsync`, `output`, `capture`, and `captureAsync`.
- 🧬 `it` type inference from Eta render calls in nearby TypeScript and JavaScript files.
- 🛠 Support for configurable Eta delimiters, parse prefixes, `customTags`, `varName`, `useWith`, `functionHeader`, and `outputFunctionName`.

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
- Programmatic templates named with `@`, such as `eta.render("@header", data)`.
- Layout propagation through `layout("./base")`, including layout `body` content.

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
  "eta.varName": "data",
  "eta.useWith": false,
  "eta.outputFunctionName": "print"
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
| `eta.varName` | `it` | Name of the template data variable. |
| `eta.useWith` | `false` | Exposes top-level data properties as variables. |
| `eta.functionHeader` | `""` | Extra declarations injected into the virtual template file. |
| `eta.outputFunctionName` | `output` | Name of the Eta output helper function. |

The language server can also detect simple inline configs like `new Eta({ tags: ["{{", "}}"], varName: "data" })` and `eta.configure({ ... })` near render calls.

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

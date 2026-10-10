<div align="center">

<img src="assets/icon.png" alt="Eta IntelliSense icon" width="112" height="112">

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
- ES module, namespace, import-equals, re-export and CommonJS bindings, including constructor aliases.
- `eta`, `eta/core`, `npm:eta` and `jsr:@bgub/eta` entry points (including versioned Deno specifiers).
- Dot and literal bracket calls, optional access, and methods bound with `bind`, `call` or `apply`.
- Literal names, immutable aliases, finite string unions, conditional names, concatenation and template interpolation (at most 16 alternatives).
- Inline instance configuration, `withConfig(...)`, class fields and bounded synchronous factories with parameters, defaults, constant locals and one return expression.
- Imported synchronous render wrappers that forward template names, data and receivers, including nested forwarding and default parameters.
- Finite immutable template/data records, retaining each template's matching data instead of mixing records together.
- Programmatic templates named with `@`, such as `eta.render("@header", data)`.
- Inherited and explicit data passed through `include(...)` and `layout(...)`, including layout `body` content.

`renderString(...)` and `renderStringAsync(...)` can also infer data for a `.eta` file when their source is statically traced to Node `readFileSync(...)`, awaited `fs/promises.readFile(...)`, or Eta's `readFile(...)`. Use an absolute path or anchor it with `__dirname`, `import.meta.dirname` or `new URL("./template.eta", import.meta.url)`; `fileURLToPath(...)` and aliased imports are supported. Relative filesystem reads depend on runtime working directory, so the editor leaves them unresolved. Inline strings and dynamically generated template source cannot be mapped to a file.

Nested TypeScript and JavaScript projects use their own `tsconfig.json` or `jsconfig.json`, including extended configs, path aliases, and referenced projects. Templates inherit compiler settings from their render source, including client/server configs in the same directory. Files outside a config's `include` still receive inference using the nearest project settings. Saving sources, JSON configs, or package metadata refreshes open templates automatically.

Inference uses the data argument's TypeScript or JSDoc type, including imported interfaces, nested objects, arrays, unions, spreads and callbacks with rest parameters, overloads and generics. It preserves `any` and `unknown` declared by your application. Unresolved data uses `Record<string, unknown>` and an information diagnostic explains how to supply type evidence. Reassigned aliases, arbitrary control flow, custom file loaders, dynamically computed methods and runtime framework routing use the manifest described below. Extracted Eta instance methods need their receiver bound, just as they do at runtime.

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

Static analysis cannot resolve values produced by arbitrary application code or Eta plugins. The bundled manifest builder bridges those results through an explicitly invoked project build step. Put `.eta-language-support.json` at the workspace root or a nested application's root. The extension only validates and reads it; it never imports the generator, Eta config, application modules, or plugin code.

From this repository, compile first and run:

```sh
bun run compile
node out/manifest.js init --config eta.manifest.config.mjs
# Edit the scaffold, then generate from your explicitly selected config.
node out/manifest.js generate --config eta.manifest.config.mjs --root .
node out/manifest.js check --root .
```

When using the installed extension, replace `out/manifest.js` with the `out/manifest.js` inside its extension directory. Keep the complete `out/` directory together because the CLI uses its bundled helpers and TypeScript library files. `--root` lets you keep the config in a tooling directory. `generate` executes the configuration you explicitly select; `check` only validates existing metadata.

Edit the scaffold to register the templates your application actually loads:

```js
import { Eta } from "eta";
import path from "node:path";

export default ({ builder }) => {
  const eta = new Eta({ views: path.join(builder.root, "views") });
  builder.addInput("routes.json");
  builder.addTemplate({
    path: "views/profile.eta",
    dataType: { file: "src/models.ts", export: "ProfileData" },
    eta,
    names: ["profile", "account/profile"],
  });
};
```

Type references expand exported models into self-contained types and track their source/config dependencies. Register every runtime loader, plugin, route registry and other generator input with `builder.addInput(...)`. Pass types and source locations rather than user data or secrets. A framework adapter can loop over its actual route/template registry and call `addTemplate` with each route's combined locals type. An unrelated object's `.render()` is never assumed to be Eta.

Use `source` with a `.eta-generated/*.eta` path for in-memory templates. Different existing generated contents require `overwriteGenerated: true`. Plugins that transform source, ASTs or generated functions require explicit `virtualDocument.content` and non-overlapping `mappings`; the builder rejects automatic mappings for these plugins. Mapped regions can use plugin syntax outside ordinary Eta tags. Empty templates are supported with zero mappings.

The [support matrix and adapter contract](docs/eta-support.md) describe the static boundaries and runtime path for each pattern.

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

This repository uses Bun and Node.js 22.18+ (or supported Node.js 24/26 releases).

```sh
bun install
bun run compile
bun run watch
bun run test
```

Useful scripts:

- `bun run compile` type-checks and bundles the extension into `out/` with `tsdown`.
- `bun run watch` rebuilds the bundle as source files change.
- `bun run test` compiles and runs the Vitest suite.
- `bun run test:ui` opens the Vitest UI.
- `bun run test:coverage` compiles and runs the suite once with source coverage.
- `bun run test:vscode` tests production providers and snippets in an isolated VS Code instance.

Vitest, its UI, and its coverage provider use matching versions. VS Code API types stay pinned to the extension's minimum supported editor version. TypeScript stays on 6.0.3 because the embedded language service requires its JavaScript compiler API; TypeScript 7 is not a drop-in replacement for that API.

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

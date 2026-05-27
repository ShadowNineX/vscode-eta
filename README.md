# Eta Language Support

VS Code language support for [Eta](https://eta.js.org/) templates. The extension provides syntax highlighting, snippets, diagnostics, hover documentation, completions, and TypeScript-powered language features for `.eta` files.

## Features

- Syntax highlighting for Eta tags, embedded JavaScript, HTML, strings, and comments.
- Completions for Eta helpers such as `layout`, `include`, `includeAsync`, `block`, `blockAsync`, `output`, `capture`, and `captureAsync`.
- Hover documentation for common Eta tags and built-ins.
- Diagnostics for unclosed tags, mismatched tags, and empty Eta tags.
- Snippets for common Eta patterns.
- TypeScript language server support inside Eta tags.
- `it` type inference from Eta render calls in nearby TypeScript and JavaScript files.

## Eta Syntax

```eta
<%= it.name %>
<%~ it.html %>
<% const count = it.items.length %>
<% /* Eta comments are JavaScript comments inside evaluation tags. */ %>

<% layout("./base") %>
<%~ it.body %>
<% block("title", () => { %>Page Title<% }) %>
<%~ block("title") %>

<%~ include("./partial") %>
<%~ await includeAsync("./partial") %>

<% output("<li>Generated item</li>") %>
<% const repeated = capture(() => { %>
  <strong><%= it.name %></strong>
<% }) %>

<%_ it.trimBefore %>
<%- it.trimOneNewlineBefore %>
<%= it.trimAfter _%>
<%= it.trimOneNewlineAfter -%>
```

## Type Inference

The language server scans workspace TypeScript and JavaScript files for named Eta render calls and maps the render data type back to matching `.eta` templates.

```ts
import { Eta } from "eta";

const eta = new Eta({ views: "./views" });

eta.render("profile", {
  name: "Ada",
  roles: ["admin", "editor"],
});
```

In `views/profile.eta`, the extension can treat `it` like:

```ts
{
  name: string;
  roles: string[];
}
```

Supported inference sources:

- Eta v3/v4 named template calls: `render(...)` and `renderAsync(...)`.
- Legacy Eta v2 file calls: `renderFile(...)` and `renderFileAsync(...)`.
- Programmatic templates named with `@`, such as `eta.render("@header", data)`.

`renderString(...)` and `renderStringAsync(...)` are not mapped to `.eta` files because Eta uses those APIs for inline template source.

## Current Support

This extension targets Eta v4-style projects and default `.eta` syntax:

- Default delimiters: `<%` and `%>`.
- Default data variable: `it`.
- Default built-ins: `layout`, `include`, `includeAsync`, `block`, `blockAsync`, `output`, `capture`, and `captureAsync`.

Eta runtime options can be mirrored in VS Code settings so the scanner and virtual TypeScript document match your project:

```json
{
  "eta.tags.open": "{{",
  "eta.tags.close": "}}",
  "eta.parse.interpolate": ":",
  "eta.parse.raw": "!",
  "eta.customTags": ["#"],
  "eta.varName": "data",
  "eta.useWith": false
}
```

Supported settings include custom delimiters (`tags`), custom parse prefixes, `customTags` prefixes, `varName`, `useWith`, `functionHeader`, and `outputFunctionName`.

These settings do not execute Eta configuration code. They only tell the editor how to parse templates and build the virtual TypeScript document used for completions, hover, and diagnostics.

The language server also statically detects simple local configs like `new Eta({ tags: ["{{", "}}"], varName: "data" })` and `eta.configure({ ... })` when those values are inline literals near render calls. VS Code settings still act as the explicit override for projects that build config dynamically.

### Settings Reference

- `eta.tags.open`: Opening delimiter for Eta tags. Default: `<%`.
- `eta.tags.close`: Closing delimiter for Eta tags. Default: `%>`.
- `eta.parse.exec`: Prefix for JavaScript execution tags. Default: empty string, so `<% code %>`.
- `eta.parse.interpolate`: Prefix for escaped output tags. Default: `=`, so `<%= value %>`.
- `eta.parse.raw`: Prefix for raw output tags. Default: `~`, so `<%~ html %>`.
- `eta.customTags`: Custom tag prefixes your Eta runtime handles, such as `["#"]`. The extension uses these prefixes for parsing and diagnostics; it does not run the handler functions.
- `eta.varName`: Name of the template data variable. Default: `it`.
- `eta.useWith`: Exposes top-level data properties as variables in completions, matching Eta `useWith`.
- `eta.functionHeader`: Advanced. Extra TypeScript/JavaScript declarations to inject into the virtual template file when your Eta runtime provides globals through `functionHeader`.
- `eta.outputFunctionName`: Advanced. Renames the declared output helper from `output(...)` to your Eta runtime's configured helper name.

## Additional Notes

Eta is highly configurable, and the extension focuses on editor-safe language support:

- `customTags` prefixes are used for parsing and diagnostics. Runtime handler functions remain part of your Eta app.
- Custom delimiters and parse prefixes are used by diagnostics and language-server features. Syntax coloring is optimized for the default `<% %>` delimiters.
- Simple inline `new Eta({ ... })` and `eta.configure({ ... })` configs are detected automatically. VS Code settings are available for dynamic or imported config.
- Workspace settings apply broadly across the opened workspace.
- `renderString(...)` and `renderStringAsync(...)` are treated as inline Eta source, so they are not mapped to `.eta` template files.
- Eta plugins and output-only runtime behavior remain in the runtime layer of your app.

## Development

This repository uses Bun for local development.

```sh
bun install
bun run compile
bun run watch
bun run test
```

Useful scripts:

- `bun run compile` builds the extension into `out/`.
- `bun run watch` runs TypeScript in watch mode.
- `bun run test` compiles and runs the Vitest suite.
- `bun run test:ui` opens the Vitest UI.
- `bun run test:coverage` runs coverage.

## Project Structure

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

## Demo Workspace

The `demo/` folder contains a standalone Eta workspace with typed render calls and matching templates. Open it in VS Code to try the extension against several Eta usage patterns.

Scenario demos include:

- `quickstart-file-render`
- `layouts-and-blocks`
- `partials-and-helpers`
- `async-render`
- `config-options`
- `api-surface`
- `syntax-edge-cases`

## Documentation

- [Eta](https://eta.js.org/)
- [Eta v4 Quickstart](https://eta.js.org/docs/4.x.x/intro/quickstart)
- [Template Syntax](https://eta.js.org/docs/4.x.x/syntax/template-syntax)
- [Layouts and Blocks](https://eta.js.org/docs/4.x.x/syntax/layouts-and-blocks)
- [Helpers](https://eta.js.org/docs/4.x.x/syntax/helpers)
- [Configuration Options](https://eta.js.org/docs/4.x.x/api/configuration)

## License

MIT

# Eta Extension Demo Workspace

Open this folder in VS Code to try the Eta language extension against real render calls and matching `.eta` templates.

The original demo lives in `src/` and `views/`. Additional focused scenarios live in `scenarios/`:

- `quickstart-file-render` mirrors the Eta quickstart flow with a `views` directory and `eta.render(...)`.
- `layouts-and-blocks` exercises `layout()`, `block()`, fallback blocks, and layout data.
- `partials-and-helpers` exercises `include()`, `output()`, and `capture()`.
- `async-render` exercises `renderAsync`, `includeAsync()`, and `captureAsync()`.
- `config-options` exercises runtime-safe configuration options while keeping the default `<% %>` syntax that this extension currently understands.
- `api-surface` exercises named file rendering with `render`/`renderAsync`, programmatic `@` templates, and browser-style `eta/core` + `renderString`.
- `syntax-edge-cases` exercises conditionals, array loops, object loops, `console.log`, whitespace trim markers, and delimiters inside strings/comments.

Each scenario has a `src/index.ts` file with typed render data and a local `views/` folder. The language server scans the TypeScript render calls and infers the `it` type for templates with matching basenames.

Note: Eta supports custom delimiters (`tags`) and custom data variable names (`varName`), but this extension currently targets the default `.eta` syntax and default `it` variable for language features. Eta v2 also exposed `renderFile`/`renderFileAsync`; Eta v4 file-backed rendering uses `render`/`renderAsync` with a configured `views` directory.

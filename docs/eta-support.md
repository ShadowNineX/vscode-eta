# Eta support and build adapters

The extension uses static type evidence where it can prove a connection to Eta. Runtime behavior is supported through the explicitly invoked manifest builder. It cannot infer arbitrary JavaScript execution from source alone.

| Usage | Automatic inference | Build adapter |
| --- | --- | --- |
| TS/JS, ESM/CommonJS, JSX, `.mts`/`.cts`/`.mjs`/`.cjs` | Eta imports, constructor aliases, methods and source data types | Register transformed source produced by another language/tool. |
| Browser/core/Deno Eta imports | Known Eta module specifiers and declarations | Register modules loaded through custom resolvers. |
| Multiple configs, referenced projects and monorepos | Template compiler settings follow their render source; matching basenames stay isolated | Use a common builder root containing all model/config inputs. |
| Method aliases, bound methods, `call`/`apply` | Immutable proven aliases, literal argument arrays and bound receivers | Register dynamic dispatch results. |
| Wrappers and factories | Bounded synchronous forwarding, parameters/defaults and constant locals | Evaluate arbitrary control flow in the trusted build. |
| Template choices and paired data | At most 16 static name alternatives and safe finite immutable records | Enumerate runtime routes/names and register each template's model type. |
| File-backed `renderString` | Anchored Node/Eta reads with supported provenance | Register custom loaders and their actual physical paths. |
| Framework rendering | Proven Eta render calls within the adapter | Enumerate the framework registry and combined application/request locals. |
| Include/layout, blocks and helpers | Static relationships, inherited/explicit data and layout body | Declare runtime relationships, names and definition/symbol locations. |
| Custom tags | Explicit JavaScript/text language metadata | Supply final virtual code/maps when handlers change JavaScript structure. |
| Plugins, generated or transformed templates | Ordinary physical Eta source without transformations | Materialize source and provide final code, mappings and plugin diagnostics. |
| Missing evidence or stale metadata | `unknown` fallback and actionable information diagnostics | Generate or regenerate the manifest; app-declared `any` remains app-owned. |
| Unsaved Eta documents | Eta/TypeScript features without file-derived render data | Save a physical template before registering its build metadata. |

## Adapter contract

The CLI supplies `{ builder, EtaManifestBuilder }` to the explicitly selected default-exported config function. Both synchronous and asynchronous configurations are accepted. The direct builder API can also be imported from the bundled `out/manifest.js` by an existing build script; `out/manifest.d.ts` provides strict TypeScript declarations. Keep the complete bundle directory and its library files together.

Config loading is limited to one execution per process so cached application modules cannot publish old data with fresh hashes. Start a fresh CLI process for each config generation. The direct builder API remains reusable in build/watch scripts that already own their runtime state; create a new builder for each snapshot.

The Node CLI tracks static imports, re-exports and literal `require` dependencies using their respective runtime resolution conditions, including dual ESM/CommonJS package entries and package/lock metadata. Register inputs reached by dynamic imports, custom module loaders or application-specific resolution explicitly with `addInput`.

`new EtaManifestBuilder({ root, inputs })` uses one real workspace root. Model files, configuration files, source locations and generated output must stay inside it. Choose a common monorepo root when models live in a shared package. Register every additional input used by runtime code with `addInput(path)`.

Each manifest permits at most 1,024 combined input and template entries and 5 MiB of JSON. Larger builds should produce separate manifests at application roots. These limits bound filesystem work during editor requests; a root's freshness is checked once per request, including inputs excluded by VS Code's watcher settings.

`addTemplate` accepts a physical `path`, a structural `dataType` or `{ file, export, config? }` type reference, an Eta instance/config through `eta`, and optional `views`, `defaultExtension`, `names`, `relationships`, `dataDefinitions`, `diagnostics`, `symbols` and `virtualDocument`. Names may carry a definition location. Locations use workspace-relative paths and UTF-16 offsets, matching TypeScript and LSP.

An adapter for any framework or loader should perform these steps:

1. Read its actual runtime registry/configuration in the trusted build process.
2. Register all registry, plugin, loader and transformation input files.
3. Resolve each runtime alias to a physical template. Materialize in-memory sources under `.eta-generated/` with `source`.
4. Attach the combined template data type, including framework locals. Use exported model types or explicit structural types.
5. For transforms, attach final virtual TypeScript and explicit source mappings. Unmapped regions have no TypeScript navigation/completion contract; mappings must remain non-overlapping in both documents.
6. Attach related-template edges, diagnostics and source/symbol locations when the runtime integration provides them.
7. Call `write()`. Run CLI `check` in CI to reject stale or invalid results.

Adapters control the quality of transformed code and maps they provide. The builder validates structure, source bounds, paths and freshness; it cannot reconstruct source maps from an arbitrary string/AST plugin. It never persists runtime data values. Keep automatic regeneration in the project's build/watch process.

## Verification

The inference suites cover positive patterns and false-positive guards, including mutation, shadowing, recursion and unrelated render methods. Manifest suites cover generation, hashing, source mapping, output validation and explicit CLI execution. The bundled stdio tests exercise runtime names, model types, generated/transformed source, nested manifest ownership and recovery after inputs change without watcher notifications. Native VS Code tests exercise real providers and snippets, including untitled documents.

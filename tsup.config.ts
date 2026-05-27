import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    extension: "src/extension.ts",
    server: "src/server.ts",
  },
  outDir: "out",
  clean: true,
  bundle: true,
  splitting: false,
  sourcemap: false,
  dts: false,
  minify: true,
  format: ["cjs"],
  platform: "node",
  target: "node18",
  onSuccess: "bun run copy:typescript-libs",
  external: ["vscode"],
  noExternal: [
    "typescript",
    "vscode-languageclient",
    "vscode-languageserver",
    "vscode-languageserver-textdocument",
  ],
});

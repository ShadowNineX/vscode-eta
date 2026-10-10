import { defineConfig } from "tsdown";

export default defineConfig({
  entry: {
    extension: "src/extension.ts",
    server: "src/server.ts",
    manifest: "src/manifest.ts",
  },
  outDir: "out",
  clean: true,
  dts: true,
  format: "cjs",
  fixedExtension: false,
  minify: true,
  platform: "node",
  sourcemap: false,
  target: "node18",
  deps: {
    alwaysBundle: [/^(?!vscode$).+/],
    neverBundle: ["vscode"],
    onlyBundle: false,
  },
  copy: [
    {
      from: "node_modules/typescript/lib/lib*.d.ts",
      to: "out",
      flatten: true,
    },
  ],
});

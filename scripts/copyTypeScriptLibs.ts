import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const typescriptLibDir = path.dirname(
  require.resolve("typescript/lib/lib.es2020.full.d.ts"),
);
const outDir = path.resolve(import.meta.dirname, "..", "out");

fs.mkdirSync(outDir, { recursive: true });

for (const fileName of fs.readdirSync(typescriptLibDir)) {
  if (/^lib.*\.d\.ts$/.test(fileName)) {
    fs.copyFileSync(
      path.join(typescriptLibDir, fileName),
      path.join(outDir, fileName),
    );
  }
}

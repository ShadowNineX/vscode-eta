import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { runManifestCli } from "../src/manifest";

const roots: string[] = [];

function root(): string {
  const value = fs.mkdtempSync(path.join(os.tmpdir(), "eta-manifest-cli-"));
  roots.push(value);
  fs.mkdirSync(path.join(value, "views"));
  fs.writeFileSync(path.join(value, "views", "card.eta"), "<%= it.name %>");
  return value;
}

afterEach(() => {
  for (const item of roots.splice(0)) fs.rmSync(item, { recursive: true, force: true });
});

describe("manifest CLI", () => {
  it.each([
    ["Error", "throw new Error('config failed');", /^config failed\r?\n$/],
    ["string", "throw 'config failed';", /^config failed\r?\n$/],
    ["object", "throw { message: 'config failed', code: 'E_CONFIG' };", /E_CONFIG/],
    ["circular object", "const error = { message: 'config failed' }; error.self = error; throw error;", /\[Circular/],
  ])("reports a thrown %s without losing useful error details", (_label, source, expected) => {
    const workspace = root();
    const config = path.join(workspace, "eta.manifest.config.mjs");
    fs.writeFileSync(config, `export default () => { ${source} };\n`);
    const result = spawnSync(process.execPath, [path.resolve("out", "manifest.js"), "generate", "--config", config, "--root", workspace], {
      encoding: "utf8",
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("config failed");
    expect(result.stderr).toMatch(expected);
    expect(result.stderr).not.toContain("[object Object]");
  });

  it("executes only an explicitly selected config to generate a manifest", async () => {
    const workspace = root();
    const config = path.join(workspace, "eta.manifest.config.mjs");
    const helper = path.join(workspace, "helper.mjs");
    fs.writeFileSync(helper, "export const type = '{ name: string }';\n");
    fs.writeFileSync(config, "import { type } from './helper.mjs'; export default ({ builder }) => { globalThis.__etaManifestRan = true; builder.addTemplate({ path: 'views/card.eta', dataType: type }); };\n");
    delete (globalThis as { __etaManifestRan?: boolean }).__etaManifestRan;
    await expect(runManifestCli(["check", "--root", workspace])).rejects.toThrow();
    expect((globalThis as { __etaManifestRan?: boolean }).__etaManifestRan).toBeUndefined();
    await expect(runManifestCli(["generate", "--config", config])).resolves.toBe(0);
    expect((globalThis as { __etaManifestRan?: boolean }).__etaManifestRan).toBe(true);
    await expect(runManifestCli(["check", "--root", workspace])).resolves.toBe(0);
    fs.writeFileSync(helper, "export const type = '{ changed: boolean }';\n");
    await expect(runManifestCli(["check", "--root", workspace])).rejects.toThrow();
    await expect(runManifestCli(["generate", "--config", config])).rejects.toThrow("fresh `node out/manifest.js generate`");
  });

  it("scaffolds without overwriting an existing config", async () => {
    const workspace = root();
    const config = path.join(workspace, "eta.manifest.config.mjs");
    await expect(runManifestCli(["init", "--config", config])).resolves.toBe(0);
    await expect(runManifestCli(["init", "--config", config])).rejects.toThrow("Refusing to overwrite");
  });

  it("runs the bundled command only for generate, never for check", () => {
    const workspace = root();
    const marker = path.join(workspace, "config-ran.txt");
    fs.mkdirSync(path.join(workspace, "scripts"));
    const config = path.join(workspace, "scripts", "eta.manifest.config.mjs");
    fs.writeFileSync(config, `import { writeFileSync } from 'node:fs'; export default ({ builder }) => { writeFileSync(${JSON.stringify(marker)}, 'ran'); builder.addTemplate({ path: 'views/card.eta', dataType: '{}' }); };\n`);
    const command = path.resolve("out", "manifest.js");
    expect(() => execFileSync(process.execPath, [command, "check", "--root", workspace], { stdio: "pipe" })).toThrow();
    expect(fs.existsSync(marker)).toBe(false);
    execFileSync(process.execPath, [command, "generate", "--config", config, "--root", workspace], { stdio: "pipe" });
    expect(fs.readFileSync(marker, "utf8")).toBe("ran");
  });

  it("supports immutable data URL imports in explicitly selected configs", () => {
    const workspace = root();
    const config = path.join(workspace, "eta.manifest.config.mjs");
    const moduleUrl = `data:text/javascript,${encodeURIComponent("export const dataType = '{ name: string }';")}`;
    fs.writeFileSync(config, `import { dataType } from ${JSON.stringify(moduleUrl)}; export default ({ builder }) => builder.addTemplate({ path: 'views/card.eta', dataType });\n`);
    const command = path.resolve("out", "manifest.js");
    execFileSync(process.execPath, [command, "generate", "--config", config, "--root", workspace], { stdio: "pipe" });
    expect(() => execFileSync(process.execPath, [command, "check", "--root", workspace], { stdio: "pipe" })).not.toThrow();
  });

  it("tracks the executed ESM export condition and CommonJS directory requires", () => {
    const workspace = root();
    const command = path.resolve("out", "manifest.js");
    const dual = path.join(workspace, "node_modules", "dual-config");
    fs.mkdirSync(dual, { recursive: true });
    fs.writeFileSync(path.join(dual, "package.json"), JSON.stringify({ name: "dual-config", type: "module", exports: { ".": { import: "./import.mjs", require: "./require.cjs" } } }));
    fs.writeFileSync(path.join(dual, "import.mjs"), "export const dataType = '{ importValue: string }';\n");
    fs.writeFileSync(path.join(dual, "require.cjs"), "exports.dataType = '{ requireValue: string }';\n");
    const esmConfig = path.join(workspace, "eta.manifest.config.mjs");
    fs.writeFileSync(esmConfig, "import { dataType } from 'dual-config'; export default ({ builder }) => builder.addTemplate({ path: 'views/card.eta', dataType });\n");
    execFileSync(process.execPath, [command, "generate", "--config", esmConfig, "--root", workspace], { stdio: "pipe" });
    fs.writeFileSync(path.join(dual, "import.mjs"), "export const dataType = '{ changedImport: boolean }';\n");
    expect(() => execFileSync(process.execPath, [command, "check", "--root", workspace], { stdio: "pipe" })).toThrow();

    const cjsWorkspace = root();
    fs.mkdirSync(path.join(cjsWorkspace, "helpers"));
    fs.writeFileSync(path.join(cjsWorkspace, "helpers", "index.js"), "exports.dataType = '{ requireValue: string }';\n");
    const cjsConfig = path.join(cjsWorkspace, "eta.manifest.config.cjs");
    fs.writeFileSync(cjsConfig, "const { dataType } = require('./helpers'); module.exports = ({ builder }) => builder.addTemplate({ path: 'views/card.eta', dataType });\n");
    execFileSync(process.execPath, [command, "generate", "--config", cjsConfig, "--root", cjsWorkspace], { stdio: "pipe" });
    fs.writeFileSync(path.join(cjsWorkspace, "helpers", "index.js"), "exports.dataType = '{ changedRequire: boolean }';\n");
    expect(() => execFileSync(process.execPath, [command, "check", "--root", cjsWorkspace], { stdio: "pipe" })).toThrow();
  });
});

import * as path from "node:path";
import { ETA_LANGUAGE_SUPPORT_MANIFEST, loadEtaLanguageSupportManifest } from "./etaManifest";
import { runManifestConfig } from "./manifestBuilder";

export * from "./manifestBuilder";
export * from "./etaManifest";

function usage(): string {
  return "Usage: eta-language-support-manifest generate --config <file> [--root <workspace>] | check [--root <dir>] | init --config <file>";
}

function valueAfter(arguments_: readonly string[], flag: string): string | undefined {
  const index = arguments_.indexOf(flag);
  return index < 0 ? undefined : arguments_[index + 1];
}

export async function runManifestCli(arguments_ = process.argv.slice(2)): Promise<number> {
  const command = arguments_[0];
  if (command === "generate") {
    const config = valueAfter(arguments_, "--config");
    if (!config) throw new Error(usage());
    await runManifestConfig(path.resolve(config), path.resolve(valueAfter(arguments_, "--root") ?? path.dirname(config)));
    return 0;
  }
  if (command === "check") {
    const root = path.resolve(valueAfter(arguments_, "--root") ?? process.cwd());
    const result = loadEtaLanguageSupportManifest(root);
    if (result.status === "loaded") return 0;
    throw new Error(result.messages.join("\n") || `No ${ETA_LANGUAGE_SUPPORT_MANIFEST} in ${root}`);
  }
  if (command === "init") {
    const config = valueAfter(arguments_, "--config");
    if (!config) throw new Error(usage());
    const target = path.resolve(config);
    if (require("node:fs").existsSync(target)) throw new Error(`Refusing to overwrite ${target}`);
    require("node:fs").mkdirSync(path.dirname(target), { recursive: true });
    require("node:fs").writeFileSync(target, "export default async ({ builder }) => {\n  builder.addTemplate({\n    path: \"views/example.eta\",\n    dataType: \"Record<string, unknown>\",\n  });\n};\n", "utf8");
    return 0;
  }
  throw new Error(usage());
}

if (require.main === module) {
  void runManifestCli().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}

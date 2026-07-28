import * as fs from "node:fs";
import * as path from "node:path";
import { runTests } from "@vscode/test-electron";

async function main(): Promise<void> {
  const extensionDevelopmentPath = path.resolve(process.cwd());
  const extensionTestsPath = path.resolve(
    process.cwd(),
    "tests",
    "vscode",
    "suite",
    "index.js",
  );
  const workspacePath = path.resolve(
    process.cwd(),
    "tests",
    "vscode",
    "fixtures",
    "workspace",
  );
  const installedPath =
    process.env.VSCODE_EXECUTABLE_PATH ??
    (process.platform === "win32"
      ? path.join(
          process.env.LOCALAPPDATA ?? "",
          "Programs",
          "Microsoft VS Code",
          "Code.exe",
        )
      : undefined);

  await runTests({
    extensionDevelopmentPath,
    extensionTestsPath,
    launchArgs: [
      workspacePath,
      "--disable-extensions",
      "--skip-release-notes",
      "--skip-welcome",
    ],
    reuseMachineInstall: false,
    vscodeExecutablePath:
      installedPath && fs.existsSync(installedPath) ? installedPath : undefined,
  });
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});

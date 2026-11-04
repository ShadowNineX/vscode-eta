import * as fs from "node:fs";
import * as os from "node:os";
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
  const fixturePath = path.resolve(
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

  const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), "eta-vscode-"));
  try {
    fs.cpSync(fixturePath, workspacePath, { recursive: true });
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
  } finally {
    if (path.dirname(workspacePath) === path.resolve(os.tmpdir())) {
      fs.rmSync(workspacePath, { recursive: true, force: true });
    }
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});

import * as vscode from "vscode";
import * as path from "node:path";
import {
  LanguageClient,
  LanguageClientOptions,
  ServerOptions,
  TransportKind,
} from "vscode-languageclient/node";
import { createExtensionLogger, type EtaLogger } from "./logging";
import {
  EtaLanguageOptions,
  normalizeEtaLanguageOptions,
} from "./etaConfig";

let client: LanguageClient;
let log: vscode.LogOutputChannel;
let logger: EtaLogger;

function getEtaLanguageOptions(): EtaLanguageOptions {
  const config = vscode.workspace.getConfiguration("eta");
  return normalizeEtaLanguageOptions({
    tags: [
      config.get<string>("tags.open") ?? "<%",
      config.get<string>("tags.close") ?? "%>",
    ],
    parse: {
      exec: config.get<string>("parse.exec") ?? "",
      interpolate: config.get<string>("parse.interpolate") ?? "=",
      raw: config.get<string>("parse.raw") ?? "~",
    },
    customTags: config.get<string[]>("customTags") ?? [],
    customTagTypes:
      config.get<EtaLanguageOptions["customTagTypes"]>("customTagTypes") ?? {},
    varName: config.get<string>("varName") ?? "it",
    useWith: config.get<boolean>("useWith") ?? false,
    functionHeader: config.get<string>("functionHeader") ?? "",
    outputFunctionName: config.get<string>("outputFunctionName") ?? "output",
    async: config.get<boolean>("async") ?? false,
    autoEscape: config.get<boolean>("autoEscape") ?? true,
    autoFilter: config.get<boolean>("autoFilter") ?? false,
    autoTrim:
      config.get<EtaLanguageOptions["autoTrim"]>("autoTrim") ?? [false, "nl"],
    rmWhitespace: config.get<boolean>("rmWhitespace") ?? false,
  });
}

export function activate(context: vscode.ExtensionContext): void {
  log = vscode.window.createOutputChannel("Eta", { log: true });
  logger = createExtensionLogger(log);
  context.subscriptions.push(log);
  logger.info("Extension activated");

  // ── Language Server (JS/TS IntelliSense inside Eta tags) ─────────────────
  const serverModule = context.asAbsolutePath(path.join("out", "server.js"));
  const serverOptions: ServerOptions = {
    run: { module: serverModule, transport: TransportKind.ipc },
    debug: { module: serverModule, transport: TransportKind.ipc },
  };
  const clientOptions: LanguageClientOptions = {
    documentSelector: [
      { scheme: "file", language: "eta" },
      { scheme: "untitled", language: "eta" },
    ],
    initializationOptions: {
      etaLanguageOptions: getEtaLanguageOptions(),
    },
    synchronize: {
      configurationSection: "eta",
      // The server filters ordinary source/config changes and custom manifest
      // inputs. It also checks input stamps when watchers exclude a path.
      fileEvents: [
        vscode.workspace.createFileSystemWatcher("**/*"),
      ],
    },
  };
  client = new LanguageClient(
    "eta-lsp",
    "Eta Language Server",
    serverOptions,
    clientOptions,
  );
  logger.info(`Starting language server: ${serverModule}`);
  client
    .start()
    .then(() => {
      logger.info("Language server started");
    })
    .catch((err: unknown) => {
      logger.error(`Language server failed to start: ${err}`);
    });
}

export function deactivate(): Thenable<void> | undefined {
  logger?.info("Extension deactivated");
  if (!client) return undefined;
  return client.stop();
}

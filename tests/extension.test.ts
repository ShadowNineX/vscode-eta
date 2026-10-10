import { describe, expect, it, vi } from "vitest";
import * as path from "node:path";
import type * as vscode from "vscode";

const mocks = vi.hoisted(() => {
  const configuration: Record<string, unknown> = {
    "tags.open": "{{",
    "tags.close": "}}",
    "parse.exec": "",
    "parse.interpolate": ":",
    "parse.raw": "!",
    customTags: ["#"],
    customTagTypes: { "#": "text", "@": "javascript" },
    varName: "data",
    useWith: true,
    functionHeader: "const helper = data.name;",
    outputFunctionName: "print",
    async: true,
    autoEscape: false,
    autoFilter: true,
    autoTrim: "slurp",
    rmWhitespace: true,
  };
  const output = {
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    dispose: vi.fn(),
  };
  const client = {
    start: vi.fn(() => Promise.resolve()),
    stop: vi.fn(() => Promise.resolve()),
  };
  return {
    configuration,
    output,
    client,
    languageClient: vi.fn(),
    createFileSystemWatcher: vi.fn((pattern: string) => ({ pattern })),
    registerCompletionItemProvider: vi.fn(),
    registerHoverProvider: vi.fn(),
  };
});

vi.mock("vscode", () => ({
  window: {
    createOutputChannel: vi.fn(() => mocks.output),
  },
  workspace: {
    getConfiguration: vi.fn(() => ({
      get: (key: string) => mocks.configuration[key],
    })),
    createFileSystemWatcher: mocks.createFileSystemWatcher,
  },
  languages: {
    registerCompletionItemProvider: mocks.registerCompletionItemProvider,
    registerHoverProvider: mocks.registerHoverProvider,
  },
}));

vi.mock("vscode-languageclient/node", () => ({
  LanguageClient: vi.fn(function (...args: unknown[]) {
    mocks.languageClient(...args);
    return mocks.client;
  }),
  TransportKind: { ipc: "ipc" },
}));

describe("production extension activation", () => {
  it("starts the language client with the complete Eta configuration", async () => {
    const extension = await import("../src/extension");
    const subscriptions: vscode.Disposable[] = [];
    const extensionRoot = path.join("C:", "fixture", "vscode-eta");
    const context = {
      subscriptions,
      asAbsolutePath: (relative: string) => path.join(extensionRoot, relative),
    } as unknown as vscode.ExtensionContext;

    extension.activate(context);

    expect(mocks.languageClient).toHaveBeenCalledTimes(1);
    const [id, name, serverOptions, clientOptions] =
      mocks.languageClient.mock.calls[0];
    const serverModule = path.join(extensionRoot, "out", "server.js");
    expect([id, name]).toEqual(["eta-lsp", "Eta Language Server"]);
    expect(serverOptions).toEqual({
      run: { module: serverModule, transport: "ipc" },
      debug: { module: serverModule, transport: "ipc" },
    });
    expect(clientOptions).toMatchObject({
      documentSelector: [
        { scheme: "file", language: "eta" },
        { scheme: "untitled", language: "eta" },
      ],
      initializationOptions: {
        etaLanguageOptions: {
          tags: ["{{", "}}"],
          parse: { exec: "", interpolate: ":", raw: "!" },
          customTags: ["#"],
          customTagTypes: { "#": "text", "@": "javascript" },
          varName: "data",
          useWith: true,
          functionHeader: "const helper = data.name;",
          outputFunctionName: "print",
          async: true,
          autoEscape: false,
          autoFilter: true,
          autoTrim: "slurp",
          rmWhitespace: true,
        },
      },
      synchronize: { configurationSection: "eta" },
    });
    expect(mocks.createFileSystemWatcher).toHaveBeenCalledWith(
      "**/*",
    );
    expect(mocks.registerCompletionItemProvider).not.toHaveBeenCalled();
    expect(mocks.registerHoverProvider).not.toHaveBeenCalled();
    expect(mocks.client.start).toHaveBeenCalledTimes(1);
    expect(subscriptions).toContain(mocks.output);

    await extension.deactivate();
    expect(mocks.client.stop).toHaveBeenCalledTimes(1);
  });
});

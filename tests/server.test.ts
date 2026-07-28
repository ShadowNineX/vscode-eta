import { describe, it, expect, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import {
  getDataDefinitionsForUri,
  templateDataDefinitionMap,
  templateDataTypeMap,
  workspaceEtaFiles,
} from "../src/typeInference";

const mocks = vi.hoisted(() => {
  return {
    connection: {
      onInitialize: vi.fn(),
      onCompletion: vi.fn(),
      onHover: vi.fn(),
      onDefinition: vi.fn(),
      onReferences: vi.fn(),
      onRenameRequest: vi.fn(),
      onSignatureHelp: vi.fn(),
      sendDiagnostics: vi.fn(),
      languages: {
        semanticTokens: {
          on: vi.fn(),
        },
      },
      onDidChangeWatchedFiles: vi.fn(),
      listen: vi.fn(),
      console: {
        debug: vi.fn(),
        error: vi.fn(),
        info: vi.fn(),
        log: vi.fn(),
        warn: vi.fn(),
      },
    },
    documents: {
      onDidOpen: vi.fn(),
      onDidChangeContent: vi.fn(),
      get: vi.fn(),
      listen: vi.fn(),
    },
  };
});

vi.mock("vscode-languageserver/node", () => ({
  createConnection: vi.fn(function () {
    return mocks.connection;
  }),
  TextDocuments: vi.fn(function () {
    return mocks.documents;
  }),
  ProposedFeatures: { all: "all" },
  TextDocumentSyncKind: { Incremental: 2 },
  FileChangeType: { Created: 1, Changed: 2, Deleted: 3 },
  MarkupKind: { Markdown: "markdown" },
  CompletionItemKind: {
    Text: 1,
    Method: 2,
    Function: 3,
    Variable: 6,
    Class: 7,
    Interface: 8,
    Module: 9,
    Property: 10,
    Constant: 21,
    Keyword: 14,
    TypeParameter: 25,
    File: 17,
  },
  DiagnosticSeverity: {
    Error: 1,
    Warning: 2,
    Information: 3,
  },
}));

vi.mock("vscode-languageserver-textdocument", () => ({
  TextDocument: { create: vi.fn() },
}));

describe("server entrypoint", () => {
  it("registers LSP handlers and starts listening", async () => {
    // Import after Vitest installs mocks because the entrypoint registers on load.
    await import("../src/server");

    expect(mocks.connection.onInitialize).toHaveBeenCalledTimes(1);
    const initialize = mocks.connection.onInitialize.mock.calls[0][0];
    const initializeResult = initialize({
      initializationOptions: {},
      workspaceFolders: [],
    });
    expect(initializeResult.capabilities.definitionProvider).toBe(true);
    expect(initializeResult.capabilities.referencesProvider).toBe(true);
    expect(initializeResult.capabilities.renameProvider).toBe(true);
    expect(initializeResult.capabilities.signatureHelpProvider).toBeTruthy();
    expect(initializeResult.capabilities.semanticTokensProvider).toBeTruthy();

    expect(mocks.connection.onCompletion).toHaveBeenCalledTimes(1);
    expect(mocks.connection.onHover).toHaveBeenCalledTimes(1);
    expect(mocks.connection.onDefinition).toHaveBeenCalledTimes(1);
    expect(mocks.connection.onReferences).toHaveBeenCalledTimes(1);
    expect(mocks.connection.onRenameRequest).toHaveBeenCalledTimes(1);
    expect(mocks.connection.onSignatureHelp).toHaveBeenCalledTimes(1);
    expect(
      mocks.connection.languages.semanticTokens.on,
    ).toHaveBeenCalledTimes(1);
    expect(mocks.connection.onDidChangeWatchedFiles).toHaveBeenCalledTimes(1);
    expect(mocks.documents.onDidOpen).toHaveBeenCalledTimes(1);
    expect(mocks.documents.onDidChangeContent).toHaveBeenCalledTimes(1);
    expect(mocks.documents.listen).toHaveBeenCalledTimes(1);
    const completion = mocks.connection.onCompletion.mock.calls[0][0];
    const hover = mocks.connection.onHover.mock.calls[0][0];
    const missingDocumentParams = {
      textDocument: { uri: "file:///missing.eta" },
      position: { line: 0, character: 0 },
    };
    expect(completion(missingDocumentParams)).toEqual([]);
    expect(hover(missingDocumentParams)).toBeNull();

    const plainDocument = {
      uri: "file:///plain.eta",
      getText: () => "No Eta tag here",
    };
    mocks.documents.get.mockReturnValue(plainDocument);
    expect(
      completion({
        textDocument: { uri: plainDocument.uri },
        position: { line: 0, character: 3 },
      }),
    ).toEqual([]);

    const source = "<% const value = 1; %>\n<%= value %>";
    const document = {
      uri: pathToFileURL(path.join(os.tmpdir(), "template.eta")).toString(),
      getText: () => source,
    };
    mocks.documents.get.mockReturnValue(document);
    mocks.documents.onDidOpen.mock.calls[0][0]({ document });

    const definition = mocks.connection.onDefinition.mock.calls[0][0]({
      textDocument: { uri: document.uri },
      position: { line: 1, character: 5 },
    });
    expect(definition).toEqual([
      {
        uri: document.uri,
        range: {
          start: { line: 0, character: 9 },
          end: { line: 0, character: 14 },
        },
      },
    ]);
    const symbolParams = {
      textDocument: { uri: document.uri },
      position: { line: 1, character: 5 },
    };
    const symbolReferences = mocks.connection.onReferences.mock.calls[0][0]({
      ...symbolParams,
      context: { includeDeclaration: true },
    });
    expect(symbolReferences).toHaveLength(2);
    const symbolRename = mocks.connection.onRenameRequest.mock.calls[0][0]({
      ...symbolParams,
      newName: "renamed",
    });
    expect(symbolRename.changes[document.uri]).toHaveLength(2);

    const signatureSource = "<% include( %>";
    const signatureDocument = {
      uri: document.uri,
      getText: () => signatureSource,
    };
    mocks.documents.get.mockReturnValue(signatureDocument);
    const signatureHelp = mocks.connection.onSignatureHelp.mock.calls[0][0]({
      textDocument: { uri: document.uri },
      position: { line: 0, character: signatureSource.indexOf("(") + 1 },
    });
    expect(signatureHelp.signatures[0].label).toContain("include(");

    const renderSource = `const payload = { user: { name: "Ada" } };`;
    const renderSourcePath = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), "eta-definition-")),
      "render.ts",
    );
    fs.writeFileSync(renderSourcePath, renderSource);
    const nameStart = renderSource.indexOf("name");
    templateDataTypeMap.set(
      "template",
      "{ user: { name: string } }",
    );
    templateDataDefinitionMap.set(
      "template",
      new Map([
        [
          JSON.stringify(["user", "name"]),
          [
            {
              fileName: renderSourcePath,
              start: nameStart,
              length: "name".length,
            },
          ],
        ],
      ]),
    );

    expect(
      getDataDefinitionsForUri(document.uri, ["user", "name"]),
    ).toHaveLength(1);

    const dataSource = "<%= it.user.name %>";
    const dataDocument = {
      uri: document.uri,
      getText: () => dataSource,
    };
    mocks.documents.get.mockReturnValue(dataDocument);
    const dataDefinition = mocks.connection.onDefinition.mock.calls[0][0]({
      textDocument: { uri: dataDocument.uri },
      position: { line: 0, character: 13 },
    });
    expect(dataDefinition).toEqual([
      {
        uri: pathToFileURL(renderSourcePath).toString(),
        range: {
          start: { line: 0, character: nameStart },
          end: { line: 0, character: nameStart + "name".length },
        },
      },
    ]);

    const diagnosticSource = '<%= "unterminated';
    const diagnosticDocument = {
      uri: pathToFileURL(path.join(os.tmpdir(), "diagnostic.eta")).toString(),
      getText: () => diagnosticSource,
    };
    mocks.documents.get.mockReturnValue(diagnosticDocument);
    mocks.documents.onDidOpen.mock.calls[0][0]({
      document: diagnosticDocument,
    });
    const lastDiagnosticCall =
      mocks.connection.sendDiagnostics.mock.calls[
        mocks.connection.sendDiagnostics.mock.calls.length - 1
      ][0];
    expect(lastDiagnosticCall.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ message: "Unclosed string in Eta tag" }),
      ]),
    );
    const typeDiagnosticSource = "<%= definitelyMissing %>";
    const typeDiagnosticDocument = {
      uri: pathToFileURL(path.join(os.tmpdir(), "type-diagnostic.eta")).toString(),
      getText: () => typeDiagnosticSource,
    };
    mocks.documents.get.mockReturnValue(typeDiagnosticDocument);
    mocks.documents.onDidOpen.mock.calls[0][0]({
      document: typeDiagnosticDocument,
    });
    const lastTypeDiagnosticCall =
      mocks.connection.sendDiagnostics.mock.calls[
        mocks.connection.sendDiagnostics.mock.calls.length - 1
      ][0];
    expect(
      lastTypeDiagnosticCall.diagnostics.some(
        (diagnostic: { source: string; message: string }) =>
          diagnostic.source === "TypeScript" &&
          diagnostic.message.includes("definitelyMissing"),
      ),
    ).toBe(true);

    const navigationDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "eta-navigation-"),
    );
    const pagePath = path.join(navigationDir, "page.eta");
    const partialPath = path.join(navigationDir, "partial.eta");
    const pageUri = pathToFileURL(pagePath).toString();
    const partialUri = pathToFileURL(partialPath).toString();
    const pathSource = '<%~ include("./partial") %>';
    fs.writeFileSync(pagePath, pathSource);
    fs.writeFileSync(partialPath, "<%= it.name %>");
    workspaceEtaFiles.add(pagePath);
    workspaceEtaFiles.add(partialPath);
    const pathDocument = { uri: pageUri, getText: () => pathSource };
    mocks.documents.get.mockImplementation((uri: string) =>
      uri === pageUri ? pathDocument : undefined,
    );

    const pathDefinition = mocks.connection.onDefinition.mock.calls[0][0]({
      textDocument: { uri: pageUri },
      position: { line: 0, character: pathSource.indexOf("partial") + 2 },
    });
    expect(pathDefinition?.[0].uri.toLowerCase()).toBe(partialUri.toLowerCase());

    const partialCompletionSource = '<%~ include("./par';
    const partialCompletionDocument = {
      uri: pageUri,
      getText: () => partialCompletionSource,
    };
    mocks.documents.get.mockImplementation((uri: string) =>
      uri === pageUri ? partialCompletionDocument : undefined,
    );
    const pathCompletions = completion({
      textDocument: { uri: pageUri },
      position: { line: 0, character: partialCompletionSource.length },
    });
    expect(pathCompletions.map((item: { label: string }) => item.label)).toContain(
      "./partial",
    );

    const blockChildPath = path.join(navigationDir, "child.eta");
    const blockLayoutPath = path.join(navigationDir, "layout.eta");
    const blockChildUri = pathToFileURL(blockChildPath).toString();
    const blockLayoutUri = pathToFileURL(blockLayoutPath).toString();
    const blockChildSource = '<% block("head", () => {}) %>';
    const blockLayoutSource = '<% block("head") %>';
    fs.writeFileSync(blockChildPath, blockChildSource);
    fs.writeFileSync(blockLayoutPath, blockLayoutSource);
    workspaceEtaFiles.add(blockChildPath);
    workspaceEtaFiles.add(blockLayoutPath);
    const openDocuments = new Map([
      [
        blockLayoutUri,
        { uri: blockLayoutUri, getText: () => blockLayoutSource },
      ],
    ]);
    mocks.documents.get.mockImplementation((uri: string) =>
      openDocuments.get(uri),
    );
    const blockParams = {
      textDocument: { uri: blockLayoutUri },
      position: { line: 0, character: blockLayoutSource.indexOf("head") + 1 },
    };
    const blockDefinition = mocks.connection.onDefinition.mock.calls[0][0](
      blockParams,
    );
    expect(blockDefinition?.[0].uri).toBe(blockChildUri);
    const references = mocks.connection.onReferences.mock.calls[0][0]({
      ...blockParams,
      context: { includeDeclaration: true },
    });
    expect(references).toHaveLength(2);
    const rename = mocks.connection.onRenameRequest.mock.calls[0][0]({
      ...blockParams,
      newName: "banner",
    });
    expect(Object.keys(rename.changes)).toEqual(
      expect.arrayContaining([blockChildUri, blockLayoutUri]),
    );

    initialize({
      initializationOptions: {
        etaLanguageOptions: { customTags: ["#"] },
      },
      workspaceFolders: [],
    });
    const semanticSource = "<%# custom content %>";
    const semanticDocument = { uri: pageUri, getText: () => semanticSource };
    mocks.documents.get.mockImplementation((uri: string) =>
      uri === pageUri ? semanticDocument : undefined,
    );
    const semanticTokens =
      mocks.connection.languages.semanticTokens.on.mock.calls[0][0]({
        textDocument: { uri: pageUri },
      });
    expect(semanticTokens.data).toEqual([0, 0, 3, 0, 0]);

    workspaceEtaFiles.delete(pagePath);
    workspaceEtaFiles.delete(partialPath);
    workspaceEtaFiles.delete(blockChildPath);
    workspaceEtaFiles.delete(blockLayoutPath);
    expect(mocks.connection.sendDiagnostics).toHaveBeenCalled();

    expect(mocks.connection.listen).toHaveBeenCalledTimes(1);
  }, 30_000);
});

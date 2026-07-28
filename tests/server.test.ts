import { describe, it, expect, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import {
  getDataDefinitionsForUri,
  templateDataDefinitionMap,
  templateDataTypeMap,
} from "../src/typeInference";

const mocks = vi.hoisted(() => {
  return {
    connection: {
      onInitialize: vi.fn(),
      onCompletion: vi.fn(),
      onHover: vi.fn(),
      onDefinition: vi.fn(),
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

    expect(mocks.connection.onCompletion).toHaveBeenCalledTimes(1);
    expect(mocks.connection.onHover).toHaveBeenCalledTimes(1);
    expect(mocks.connection.onDefinition).toHaveBeenCalledTimes(1);
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

    expect(mocks.connection.listen).toHaveBeenCalledTimes(1);
  }, 30_000);
});

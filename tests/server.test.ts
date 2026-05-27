import { describe, it, expect, vi } from "vitest";

const mocks = vi.hoisted(() => {
  return {
    connection: {
      onInitialize: vi.fn(),
      onCompletion: vi.fn(),
      onHover: vi.fn(),
      onDidChangeWatchedFiles: vi.fn(),
      listen: vi.fn(),
      console: { log: vi.fn() },
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
    await import("../src/server");

    expect(mocks.connection.onInitialize).toHaveBeenCalledTimes(1);
    expect(mocks.connection.onCompletion).toHaveBeenCalledTimes(1);
    expect(mocks.connection.onHover).toHaveBeenCalledTimes(1);
    expect(mocks.connection.onDidChangeWatchedFiles).toHaveBeenCalledTimes(1);
    expect(mocks.documents.onDidOpen).toHaveBeenCalledTimes(1);
    expect(mocks.documents.onDidChangeContent).toHaveBeenCalledTimes(1);
    expect(mocks.documents.listen).toHaveBeenCalledTimes(1);
    expect(mocks.connection.listen).toHaveBeenCalledTimes(1);
  });
});

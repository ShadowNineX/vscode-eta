import { describe, it, expect, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import {
  getDataDefinitionsForUri,
  templateDataDefinitionMap,
  templateDataTypeMap,
  templateRelationshipMap,
  workspaceEtaFiles,
  workspaceTsFiles,
} from "../src/typeInference";
import { canonicalTemplatePath } from "../src/templatePaths";
import { DEFAULT_ETA_LANGUAGE_OPTIONS } from "../src/etaConfig";
import {
  ETA_LANGUAGE_SUPPORT_MANIFEST,
  sha256Text,
} from "../src/etaManifest";
import { positionToOffset } from "../src/position";
import { buildVirtualDocument } from "../src/virtualDocument";

const mocks = vi.hoisted(() => {
  return {
    connection: {
      onInitialize: vi.fn(),
      onInitialized: vi.fn(),
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
      workspace: {
        onDidChangeWorkspaceFolders: vi.fn(),
      },
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
      onDidClose: vi.fn(),
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
    Hint: 4,
  },
}));

vi.mock("vscode-languageserver-textdocument", () => ({
  TextDocument: { create: vi.fn() },
}));

vi.mock("node:fs", { spy: true });

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
    expect(
      initializeResult.capabilities.semanticTokensProvider.legend.tokenTypes,
    ).toContain("keyword");
    expect(initializeResult.capabilities.workspace.workspaceFolders).toEqual({
      supported: true,
      changeNotifications: true,
    });

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
    expect(mocks.connection.onInitialized).toHaveBeenCalledTimes(1);
    mocks.connection.onInitialized.mock.calls[0][0]();
    expect(
      mocks.connection.workspace.onDidChangeWorkspaceFolders,
    ).toHaveBeenCalledTimes(1);
    expect(mocks.documents.onDidClose).toHaveBeenCalledTimes(1);
    const workspaceChange =
      mocks.connection.workspace.onDidChangeWorkspaceFolders.mock.calls[0][0];
    const workspaceDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "eta-workspace-folder-"),
    );
    const workspaceTemplate = path.join(workspaceDir, "folder.eta");
    const workspaceScript = path.join(workspaceDir, "folder.mts");
    fs.writeFileSync(workspaceTemplate, "");
    fs.writeFileSync(workspaceScript, "export const value = 1;");
    const workspaceFolder = {
      uri: pathToFileURL(workspaceDir).toString(),
      name: "fixture",
    };
    workspaceChange({ added: [workspaceFolder], removed: [] });
    const hasWorkspaceFile = (files: Set<string>, expected: string) =>
      [...files].some(
        (fileName) => path.resolve(fileName) === path.resolve(expected),
      );
    expect(hasWorkspaceFile(workspaceEtaFiles, workspaceTemplate)).toBe(true);
    expect(hasWorkspaceFile(workspaceTsFiles, workspaceScript)).toBe(true);
    workspaceChange({ added: [], removed: [workspaceFolder] });
    expect(hasWorkspaceFile(workspaceEtaFiles, workspaceTemplate)).toBe(false);
    expect(hasWorkspaceFile(workspaceTsFiles, workspaceScript)).toBe(false);
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
    const childKey = canonicalTemplatePath(blockChildPath);
    const layoutKey = canonicalTemplatePath(blockLayoutPath);
    templateRelationshipMap.set(childKey, new Set([layoutKey]));
    templateRelationshipMap.set(layoutKey, new Set([childKey]));
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
        etaLanguageOptions: {
          tags: { open: "{{", close: "}}" },
          customTagTypes: { "#": "text" },
        },
      },
      workspaceFolders: [],
    });
    const semanticSource = "{{# custom content }}";
    const semanticDocument = { uri: pageUri, getText: () => semanticSource };
    mocks.documents.get.mockImplementation((uri: string) =>
      uri === pageUri ? semanticDocument : undefined,
    );
    const semanticTokens =
      mocks.connection.languages.semanticTokens.on.mock.calls[0][0]({
        textDocument: { uri: pageUri },
      });
    expect(semanticTokens.data).toEqual([0, 0, 3, 5, 0]);
    mocks.documents.onDidClose.mock.calls[0][0]({ document: semanticDocument });
    const diagnosticCalls = mocks.connection.sendDiagnostics.mock.calls;
    expect(diagnosticCalls[diagnosticCalls.length - 1][0]).toEqual({
      uri: pageUri,
      diagnostics: [],
    });

    const manifestRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "eta-manifest-server-"),
    );
    const manifestTemplatePath = path.join(manifestRoot, "profile.eta");
    const manifestDataPath = path.join(manifestRoot, "runtime-data.ts");
    const manifestTemplateUri = pathToFileURL(manifestTemplatePath).toString();
    const manifestDataUri = pathToFileURL(manifestDataPath).toString();
    const manifestSource =
      '<%= it.runtimeName %>\n<%~ include("runtime-") %>';
    const manifestDataSource =
      'export const runtimeName = "generated";\n';
    fs.writeFileSync(manifestTemplatePath, manifestSource);
    fs.writeFileSync(manifestDataPath, manifestDataSource);
    const manifestVirtual = buildVirtualDocument(
      manifestSource,
      "{ runtimeName: string }",
      DEFAULT_ETA_LANGUAGE_OPTIONS,
    );
    const manifestBodyStart = positionToOffset(
      manifestVirtual.content,
      manifestVirtual.preambleLineCount,
      0,
    );
    const runtimeReferenceStart = manifestSource.indexOf("runtimeName");
    const runtimeDefinitionStart =
      manifestDataSource.indexOf("runtimeName");
    fs.writeFileSync(
      path.join(manifestRoot, ETA_LANGUAGE_SUPPORT_MANIFEST),
      JSON.stringify({
        version: 1,
        inputs: [
          {
            path: "runtime-data.ts",
            sha256: sha256Text(manifestDataSource),
          },
        ],
        templates: [
          {
            path: "profile.eta",
            sha256: sha256Text(manifestSource),
            options: DEFAULT_ETA_LANGUAGE_OPTIONS,
            dataType: "{ runtimeName: string }",
            dataDefinitions: [
              {
                dataPath: ["runtimeName"],
                location: {
                  path: "runtime-data.ts",
                  start: runtimeDefinitionStart,
                  length: "runtimeName".length,
                },
              },
            ],
            resolution: { views: null, defaultExtension: ".eta" },
            relationships: [],
            diagnostics: [
              {
                start: runtimeReferenceStart,
                length: "runtimeName".length,
                severity: "warning",
                source: "Eta runtime generator",
                message: "Generated manifest warning",
              },
            ],
            virtualDocument: {
              content: manifestVirtual.content,
              mappings: [
                {
                  sourceStart: 0,
                  sourceLength: manifestSource.length,
                  virtualStart: manifestBodyStart,
                  virtualLength: manifestSource.length,
                },
              ],
            },
          },
        ],
        templateNames: [
          {
            name: "runtime-profile",
            template: "profile.eta",
            definition: {
              path: "runtime-data.ts",
              start: runtimeDefinitionStart,
              length: "runtimeName".length,
            },
          },
        ],
        symbols: [
          {
            id: "runtime:name",
            occurrences: [
              {
                path: "runtime-data.ts",
                start: runtimeDefinitionStart,
                length: "runtimeName".length,
                role: "definition",
              },
              {
                path: "profile.eta",
                start: runtimeReferenceStart,
                length: "runtimeName".length,
                role: "reference",
              },
            ],
          },
        ],
      }),
    );
    const manifestFolder = {
      uri: pathToFileURL(manifestRoot).toString(),
      name: "manifest-fixture",
    };
    workspaceChange({ added: [manifestFolder], removed: [] });
    const manifestDocument = {
      uri: manifestTemplateUri,
      getText: () => manifestSource,
    };
    mocks.documents.get.mockImplementation((uri: string) =>
      uri === manifestTemplateUri ? manifestDocument : undefined,
    );
    mocks.documents.onDidOpen.mock.calls[0][0]({
      document: manifestDocument,
    });

    const manifestStatSpy = vi.mocked(fs.statSync);
    try {
      for (let request = 0; request < 2; request++) {
        manifestStatSpy.mockClear();
        hover({
          textDocument: { uri: manifestTemplateUri },
          position: { line: 0, character: runtimeReferenceStart + 1 },
        });
        const observed = manifestStatSpy.mock.calls.filter(([, options]) =>
          options && typeof options === "object" && "bigint" in options && options.bigint,
        ).map(([fileName]) => String(fileName));
        expect(observed.length).toBeGreaterThanOrEqual(3);
        expect(observed.length).toBe(new Set(observed).size);
      }
    } finally {
      manifestStatSpy.mockClear();
    }

    const manifestDefinition =
      mocks.connection.onDefinition.mock.calls[0][0]({
        textDocument: { uri: manifestTemplateUri },
        position: {
          line: 0,
          character: runtimeReferenceStart + 2,
        },
      });
    expect(manifestDefinition?.[0].uri).toBe(manifestDataUri);
    const manifestReferences =
      mocks.connection.onReferences.mock.calls[0][0]({
        textDocument: { uri: manifestTemplateUri },
        position: {
          line: 0,
          character: runtimeReferenceStart + 2,
        },
        context: { includeDeclaration: true },
      });
    expect(manifestReferences).toHaveLength(2);
    const manifestRename =
      mocks.connection.onRenameRequest.mock.calls[0][0]({
        textDocument: { uri: manifestTemplateUri },
        position: {
          line: 0,
          character: runtimeReferenceStart + 2,
        },
        newName: "renamedRuntime",
      });
    expect(Object.keys(manifestRename.changes)).toEqual(
      expect.arrayContaining([manifestTemplateUri, manifestDataUri]),
    );
    const manifestDataCompletions = completion({
      textDocument: { uri: manifestTemplateUri },
      position: { line: 0, character: "<%= it.".length },
    });
    expect(
      manifestDataCompletions.map((item: { label: string }) => item.label),
    ).toContain("runtimeName");
    const manifestPathCompletions = completion({
      textDocument: { uri: manifestTemplateUri },
      position: {
        line: 1,
        character: '<%~ include("runtime-'.length,
      },
    });
    expect(
      manifestPathCompletions.map((item: { label: string }) => item.label),
    ).toContain("runtime-profile");
    const manifestDiagnosticCall =
      mocks.connection.sendDiagnostics.mock.calls[
        mocks.connection.sendDiagnostics.mock.calls.length - 1
      ][0];
    expect(manifestDiagnosticCall.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          message: "Generated manifest warning",
          source: "Eta runtime generator",
        }),
      ]),
    );
    const manifestTokens =
      mocks.connection.languages.semanticTokens.on.mock.calls[0][0]({
        textDocument: { uri: manifestTemplateUri },
      });
    expect(manifestTokens.data.length).toBeGreaterThan(0);
    const staleManifestSource = manifestSource.replace(
      "runtimeName",
      "staleValue_",
    );
    const staleManifestDocument = {
      uri: manifestTemplateUri,
      getText: () => staleManifestSource,
    };
    mocks.documents.get.mockImplementation((uri: string) =>
      uri === manifestTemplateUri ? staleManifestDocument : undefined,
    );
    mocks.documents.onDidChangeContent.mock.calls[0][0]({
      document: staleManifestDocument,
    });
    const staleDefinition =
      mocks.connection.onDefinition.mock.calls[0][0]({
        textDocument: { uri: manifestTemplateUri },
        position: {
          line: 0,
          character: staleManifestSource.indexOf("staleValue_") + 2,
        },
      });
    expect(
      staleDefinition?.some(
        (location: { uri: string }) => location.uri === manifestDataUri,
      ) ?? false,
    ).toBe(false);
    workspaceChange({ added: [], removed: [manifestFolder] });
    fs.rmSync(manifestRoot, { recursive: true, force: true });

    workspaceEtaFiles.delete(pagePath);
    workspaceEtaFiles.delete(partialPath);
    workspaceEtaFiles.delete(blockChildPath);
    workspaceEtaFiles.delete(blockLayoutPath);
    templateRelationshipMap.clear();
    expect(mocks.connection.sendDiagnostics).toHaveBeenCalled();

    expect(mocks.connection.listen).toHaveBeenCalledTimes(1);
  }, 30_000);
});

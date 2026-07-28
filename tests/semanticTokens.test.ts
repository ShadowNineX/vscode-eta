import { describe, expect, it } from "vitest";
import ts from "typescript";
import {
  DEFAULT_ETA_LANGUAGE_OPTIONS,
  normalizeEtaLanguageOptions,
} from "../src/etaConfig";
import type { EtaManifestVirtualDocument } from "../src/etaManifest";
import { positionToOffset } from "../src/position";
import {
  ETA_SEMANTIC_TOKEN_TYPES,
  collectEtaSemanticTokens,
  type EtaSemanticToken,
} from "../src/semanticTokens";
import { buildVirtualDocument } from "../src/virtualDocument";

interface SemanticFixture {
  service: ts.LanguageService;
  virtualPath: string;
}

function createLanguageService(
  virtualPath: string,
  content: string,
): SemanticFixture {
  const files = new Map([[virtualPath, content]]);
  const host: ts.LanguageServiceHost = {
    getScriptFileNames: () => [...files.keys()],
    getScriptVersion: () => "1",
    getScriptSnapshot: (fileName) => {
      const text = files.get(fileName) ?? ts.sys.readFile(fileName);
      return text === undefined
        ? undefined
        : ts.ScriptSnapshot.fromString(text);
    },
    getCurrentDirectory: ts.sys.getCurrentDirectory,
    getCompilationSettings: () => ({
      target: ts.ScriptTarget.ES2020,
      module: ts.ModuleKind.ESNext,
      strict: true,
    }),
    getDefaultLibFileName: ts.getDefaultLibFilePath,
    fileExists: (fileName) => files.has(fileName) || ts.sys.fileExists(fileName),
    readFile: (fileName) => files.get(fileName) ?? ts.sys.readFile(fileName),
    readDirectory: ts.sys.readDirectory,
  };
  return {
    service: ts.createLanguageService(host),
    virtualPath,
  };
}

function staticDocument(
  source: string,
  content: string,
  bodyStart: number,
): EtaManifestVirtualDocument {
  const mappings = [
    {
      sourceStart: 0,
      sourceLength: source.length,
      virtualStart: bodyStart,
      virtualLength: source.length,
    },
  ];
  return { content, mappings, mappingsByVirtual: mappings };
}

function tokenPairs(
  source: string,
  tokens: EtaSemanticToken[],
): Array<[string, string]> {
  return tokens.map((token) => [
    source.slice(token.start, token.start + token.length),
    ETA_SEMANTIC_TOKEN_TYPES[token.tokenType],
  ]);
}

describe("Eta semantic tokens", () => {
  it("classifies JavaScript throughout Eta tags without coloring HTML", () => {
    const source =
      '<div>plain</div><% const count = 42; const label = "ok"; const item = { name: "Ada" }; item.name; // note\ncount++; %>';
    const built = buildVirtualDocument(source);
    const bodyStart = positionToOffset(
      built.content,
      built.preambleLineCount,
      0,
    );
    const virtualDocument = staticDocument(source, built.content, bodyStart);
    const fixture = createLanguageService("semantic.eta.ts", built.content);

    const pairs = tokenPairs(
      source,
      collectEtaSemanticTokens(
        fixture.service,
        fixture.virtualPath,
        virtualDocument,
        source,
        DEFAULT_ETA_LANGUAGE_OPTIONS,
      ),
    );

    expect(pairs).toContainEqual(["const", "keyword"]);
    expect(pairs).toContainEqual(["count", "variable"]);
    expect(pairs).toContainEqual(["42", "number"]);
    expect(pairs).toContainEqual(['"ok"', "string"]);
    expect(pairs).toContainEqual(["name", "property"]);
    expect(pairs).toContainEqual(["// note", "comment"]);
    expect(pairs.some(([text]) => text.includes("plain"))).toBe(false);
  });

  it("honors dynamically configured JavaScript and text prefixes", () => {
    const options = normalizeEtaLanguageOptions({
      tags: ["{{", "}}"],
      customTags: ["@", "#"],
      customTagTypes: { "@": "javascript", "#": "text" },
    });
    const source = "{{@ const dynamicValue = /ok/; }}{{# plain text }}";
    const built = buildVirtualDocument(source, undefined, options);
    const bodyStart = positionToOffset(
      built.content,
      built.preambleLineCount,
      0,
    );
    const virtualDocument = staticDocument(source, built.content, bodyStart);
    const fixture = createLanguageService("dynamic.eta.ts", built.content);

    const pairs = tokenPairs(
      source,
      collectEtaSemanticTokens(
        fixture.service,
        fixture.virtualPath,
        virtualDocument,
        source,
        options,
      ),
    );

    expect(pairs).toContainEqual(["{{@", "operator"]);
    expect(pairs).toContainEqual(["dynamicValue", "variable"]);
    expect(pairs).toContainEqual(["/ok/", "regexp"]);
    expect(pairs.some(([text]) => text === "plain")).toBe(false);
  });

  it("projects classifications through transformed manifest mappings", () => {
    const source = "<%@ runtime-name %>";
    const virtualContent = "const generatedRuntimeName = 1;";
    const virtualStart = virtualContent.indexOf("generatedRuntimeName");
    const sourceStart = source.indexOf("runtime-name");
    const mappings = [
      {
        sourceStart,
        sourceLength: "runtime-name".length,
        virtualStart,
        virtualLength: "generatedRuntimeName".length,
      },
    ];
    const virtualDocument: EtaManifestVirtualDocument = {
      content: virtualContent,
      mappings,
      mappingsByVirtual: mappings,
    };
    const options = normalizeEtaLanguageOptions({
      customTags: ["@"],
      customTagTypes: { "@": "javascript" },
    });
    const fixture = createLanguageService("manifest.eta.ts", virtualContent);

    const pairs = tokenPairs(
      source,
      collectEtaSemanticTokens(
        fixture.service,
        fixture.virtualPath,
        virtualDocument,
        source,
        options,
      ),
    );

    expect(pairs).toContainEqual(["runtime-name", "variable"]);
  });
});

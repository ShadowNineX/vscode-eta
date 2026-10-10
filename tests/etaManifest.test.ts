import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  ETA_LANGUAGE_SUPPORT_MANIFEST,
  MAX_MANIFEST_BYTES,
  MAX_MANIFEST_FILES,
  areManifestTemplatesRelated,
  getManifestSymbolAt,
  getManifestTemplate,
  loadEtaLanguageSupportManifest,
  sha256Text,
  sourceOffsetToVirtual,
  sourceRangeToVirtual,
  virtualOffsetToSource,
  virtualRangeToSource,
  type EtaLanguageSupportManifest,
} from "../src/etaManifest";

const roots: string[] = [];

interface TestWorkspace {
  root: string;
  source: string;
  sourcePath: string;
  sourceNameStart: number;
  definitionStart: number;
  virtualContent: string;
  virtualNameStart: number;
}

function createWorkspace(): TestWorkspace {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "eta-manifest-"));
  roots.push(root);
  fs.mkdirSync(path.join(root, "views"));
  const source = "<%= it.name %>\n";
  const sourcePath = path.join(root, "views", "profile.eta");
  fs.writeFileSync(sourcePath, source);
  const definitionSource = 'export const profile = { name: "Ada" };\n';
  fs.writeFileSync(path.join(root, "data.ts"), definitionSource);
  fs.writeFileSync(path.join(root, "eta.config.ts"), "export default {};\n");
  const virtualContent =
    "function __etaTemplate(it: { name: string }) {\n  it.name;\n}\n";
  return {
    root,
    source,
    sourcePath,
    sourceNameStart: source.indexOf("name"),
    definitionStart: definitionSource.indexOf("name"),
    virtualContent,
    virtualNameStart: virtualContent.indexOf("name", virtualContent.indexOf("it.name")),
  };
}

function etaOptions(): Record<string, unknown> {
  return {
    tags: ["<%", "%>"],
    parse: { exec: "", interpolate: "=", raw: "~" },
    customTags: [],
    customTagTypes: {},
    varName: "it",
    useWith: false,
    functionHeader: "",
    outputFunctionName: "output",
    async: false,
    autoEscape: true,
    autoFilter: false,
    autoTrim: [false, "nl"],
    rmWhitespace: false,
  };
}

function createManifest(workspace: TestWorkspace): Record<string, unknown> {
  const inputSource = fs.readFileSync(
    path.join(workspace.root, "eta.config.ts"),
    "utf8",
  );
  return {
    version: 1,
    inputs: [{ path: "eta.config.ts", sha256: sha256Text(inputSource) }],
    templates: [
      {
        path: "views/profile.eta",
        sha256: sha256Text(workspace.source),
        options: etaOptions(),
        dataType: "{ name: string }",
        dataDefinitions: [
          {
            dataPath: ["name"],
            location: {
              path: "data.ts",
              start: workspace.definitionStart,
              length: "name".length,
            },
          },
        ],
        resolution: { views: "views", defaultExtension: ".eta" },
        relationships: [],
        diagnostics: [
          {
            start: workspace.sourceNameStart,
            length: "name".length,
            severity: "warning",
            source: "Eta plugin",
            message: "Generated warning",
          },
        ],
        virtualDocument: {
          content: workspace.virtualContent,
          mappings: [
            {
              sourceStart: workspace.sourceNameStart,
              sourceLength: "name".length,
              virtualStart: workspace.virtualNameStart,
              virtualLength: "name".length,
            },
          ],
        },
      },
    ],
    templateNames: [
      {
        name: "runtime-profile",
        template: "views/profile.eta",
        definition: {
          path: "data.ts",
          start: workspace.definitionStart,
          length: "name".length,
        },
      },
    ],
    symbols: [
      {
        id: "plugin:name",
        occurrences: [
          {
            path: "data.ts",
            start: workspace.definitionStart,
            length: "name".length,
            role: "definition",
          },
          {
            path: "views/profile.eta",
            start: workspace.sourceNameStart,
            length: "name".length,
            role: "reference",
          },
        ],
      },
    ],
  };
}

function writeManifest(root: string, manifest: Record<string, unknown>): void {
  fs.writeFileSync(
    path.join(root, ETA_LANGUAGE_SUPPORT_MANIFEST),
    JSON.stringify(manifest),
  );
}

function loadedManifest(workspace: TestWorkspace): EtaLanguageSupportManifest {
  writeManifest(workspace.root, createManifest(workspace));
  const result = loadEtaLanguageSupportManifest(workspace.root);
  expect(result.status).toBe("loaded");
  if (result.status !== "loaded") throw new Error(result.messages.join("\n"));
  return result.manifest;
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("Eta language-support manifest", () => {
  it("loads authoritative templates, names, diagnostics, definitions, and symbols", () => {
    const workspace = createWorkspace();
    const manifest = loadedManifest(workspace);
    const template = getManifestTemplate(
      manifest,
      workspace.sourcePath,
      workspace.source,
    );

    expect(template?.dataType).toBe("{ name: string }");
    expect(template?.options.tags).toEqual(["<%", "%>"]);
    expect(template?.resolution.views).toBe(path.join(workspace.root, "views"));
    expect(template?.dataDefinitions[0].fileName).toBe(
      path.join(workspace.root, "data.ts"),
    );
    expect(template?.diagnostics[0].message).toBe("Generated warning");
    expect(manifest.templateNames.get("runtime-profile")?.fileName).toBe(
      workspace.sourcePath,
    );
    expect(
      getManifestSymbolAt(
        manifest,
        workspace.sourcePath,
        workspace.sourceNameStart + 1,
      )?.id,
    ).toBe("plugin:name");
    expect(getManifestTemplate(manifest, workspace.sourcePath, "changed")).toBeUndefined();
  });

  it("maps source and virtual offsets and ranges in both directions", () => {
    const workspace = createWorkspace();
    const manifest = loadedManifest(workspace);
    const document = getManifestTemplate(
      manifest,
      workspace.sourcePath,
      workspace.source,
    )!.virtualDocument;

    expect(sourceOffsetToVirtual(document, workspace.sourceNameStart + 2)).toBe(
      workspace.virtualNameStart + 2,
    );
    expect(virtualOffsetToSource(document, workspace.virtualNameStart + 3)).toBe(
      workspace.sourceNameStart + 3,
    );
    expect(sourceRangeToVirtual(document, workspace.sourceNameStart, 4)).toEqual({
      start: workspace.virtualNameStart,
      length: 4,
    });
    expect(virtualRangeToSource(document, workspace.virtualNameStart, 4)).toEqual({
      start: workspace.sourceNameStart,
      length: 4,
    });
    expect(sourceOffsetToVirtual(document, 0)).toBeUndefined();
  });

  it("uses the manifest relationship graph", () => {
    const workspace = createWorkspace();
    const layoutSource = "<%= it.body %>\n";
    const layoutPath = path.join(workspace.root, "views", "layout.eta");
    fs.writeFileSync(layoutPath, layoutSource);
    const manifest = createManifest(workspace);
    const templates = manifest.templates as Array<Record<string, unknown>>;
    templates[0].relationships = ["views/layout.eta"];
    templates.push({
      ...templates[0],
      path: "views/layout.eta",
      sha256: sha256Text(layoutSource),
      relationships: ["views/profile.eta"],
      dataDefinitions: [],
      diagnostics: [],
      virtualDocument: {
        content: layoutSource,
        mappings: [
          {
            sourceStart: 0,
            sourceLength: layoutSource.length,
            virtualStart: 0,
            virtualLength: layoutSource.length,
          },
        ],
      },
    });
    writeManifest(workspace.root, manifest);
    const result = loadEtaLanguageSupportManifest(workspace.root);
    expect(result.status).toBe("loaded");
    if (result.status !== "loaded") return;

    expect(
      areManifestTemplatesRelated(result.manifest, workspace.sourcePath, layoutPath),
    ).toBe(true);
  });

  it("rejects unknown properties and malformed type syntax", () => {
    const workspace = createWorkspace();
    const manifest = createManifest(workspace);
    manifest.untrusted = true;
    writeManifest(workspace.root, manifest);
    expect(loadEtaLanguageSupportManifest(workspace.root)).toMatchObject({
      status: "invalid",
    });

    delete manifest.untrusted;
    const templates = manifest.templates as Array<Record<string, unknown>>;
    templates[0].dataType = "{ broken:";
    writeManifest(workspace.root, manifest);
    expect(loadEtaLanguageSupportManifest(workspace.root)).toMatchObject({
      status: "invalid",
    });
    const injectedManifest = createManifest(workspace);
    const injectedTemplates =
      injectedManifest.templates as Array<Record<string, unknown>>;
    injectedTemplates[0].dataType = "string; const escaped = 1";
    writeManifest(workspace.root, injectedManifest);
    expect(loadEtaLanguageSupportManifest(workspace.root)).toMatchObject({
      status: "invalid",
    });

  });

  it("rejects traversal and source locations outside their files", () => {
    const workspace = createWorkspace();
    const manifest = createManifest(workspace);
    manifest.inputs = [
      { path: "../outside.ts", sha256: "0".repeat(64) },
    ];
    writeManifest(workspace.root, manifest);
    expect(loadEtaLanguageSupportManifest(workspace.root)).toMatchObject({
      status: "invalid",
    });

    const safeManifest = createManifest(workspace);
    const templates = safeManifest.templates as Array<Record<string, unknown>>;
    const definitions = templates[0].dataDefinitions as Array<Record<string, unknown>>;
    definitions[0].location = { path: "data.ts", start: 999_999, length: 4 };
    writeManifest(workspace.root, safeManifest);
    expect(loadEtaLanguageSupportManifest(workspace.root)).toMatchObject({
      status: "invalid",
    });
  });

  it("falls back as stale when a template or declared input changes", () => {
    const workspace = createWorkspace();
    const manifest = createManifest(workspace);
    fs.writeFileSync(workspace.sourcePath, `${workspace.source}changed`);
    writeManifest(workspace.root, manifest);
    expect(loadEtaLanguageSupportManifest(workspace.root)).toMatchObject({
      status: "stale",
    });

    fs.writeFileSync(workspace.sourcePath, workspace.source);
    fs.writeFileSync(path.join(workspace.root, "eta.config.ts"), "changed\n");
    writeManifest(workspace.root, manifest);
    expect(loadEtaLanguageSupportManifest(workspace.root)).toMatchObject({
      status: "stale",
    });
  });

  it("observes safe dependencies in stale manifests, including missing inputs", () => {
    const workspace = createWorkspace();
    const manifest = createManifest(workspace);
    const input = path.join(workspace.root, "eta.config.ts");
    fs.rmSync(input);
    writeManifest(workspace.root, manifest);
    expect(loadEtaLanguageSupportManifest(workspace.root)).toMatchObject({
      status: "stale", observedFiles: expect.arrayContaining([input, workspace.sourcePath]),
    });
    fs.writeFileSync(input, "export default {};\n");
    expect(loadEtaLanguageSupportManifest(workspace.root).status).toBe("loaded");
  });

  it("bounds filesystem observations before validating oversized file collections", () => {
    const workspace = createWorkspace();
    const manifest = createManifest(workspace);
    manifest.inputs = Array.from({ length: MAX_MANIFEST_FILES }, (_, index) => ({
      path: `missing-${index}.txt`, sha256: sha256Text(""),
    }));
    writeManifest(workspace.root, manifest);
    expect(loadEtaLanguageSupportManifest(workspace.root)).toMatchObject({
      status: "invalid", observedFiles: [], messages: [expect.stringContaining("split metadata across application roots")],
    });
  });

  it("never observes an invalid manifest path outside the workspace", () => {
    const workspace = createWorkspace();
    const manifest = createManifest(workspace);
    manifest.inputs = [{ path: "../outside.txt", sha256: sha256Text("outside") }];
    writeManifest(workspace.root, manifest);
    const result = loadEtaLanguageSupportManifest(workspace.root);
    expect(result.status).toBe("invalid");
    if (result.status === "invalid") {
      expect(result.observedFiles).toEqual([workspace.sourcePath]);
    }
  });

  it("rejects overlapping mappings and ambiguous symbol ownership", () => {
    const workspace = createWorkspace();
    const manifest = createManifest(workspace);
    const templates = manifest.templates as Array<Record<string, unknown>>;
    const virtualDocument = templates[0].virtualDocument as Record<string, unknown>;
    const mappings = virtualDocument.mappings as Array<Record<string, unknown>>;
    mappings.push({ ...mappings[0] });
    writeManifest(workspace.root, manifest);
    expect(loadEtaLanguageSupportManifest(workspace.root)).toMatchObject({
      status: "invalid",
    });

    const symbolsManifest = createManifest(workspace);
    const symbols = symbolsManifest.symbols as Array<Record<string, unknown>>;
    const originalSymbol = symbols[0];
    const occurrences =
      originalSymbol.occurrences as Array<Record<string, unknown>>;
    symbols.push({
      ...originalSymbol,
      id: "plugin:other",
      occurrences: [
        {
          ...occurrences[1],
          start: (occurrences[1].start as number) + 1,
          length: (occurrences[1].length as number) - 1,
        },
      ],
    });
    expect(loadEtaLanguageSupportManifest(workspace.root)).toMatchObject({
      status: "invalid",
    });
  });

  it("accepts repeated property names in a nested data path", () => {
    const workspace = createWorkspace();
    const manifest = createManifest(workspace);
    const templates = manifest.templates as Array<Record<string, unknown>>;
    const definitions =
      templates[0].dataDefinitions as Array<Record<string, unknown>>;
    definitions[0].dataPath = ["node", "node"];
    writeManifest(workspace.root, manifest);
    const result = loadEtaLanguageSupportManifest(workspace.root);
    if (result.status !== "loaded") throw new Error(result.messages.join("\n"));
  });

  it("accepts an empty physical template with no source mappings", () => {
    const workspace = createWorkspace();
    fs.writeFileSync(workspace.sourcePath, "");
    const manifest = createManifest(workspace);
    const templates = manifest.templates as Array<Record<string, unknown>>;
    templates[0].sha256 = sha256Text("");
    templates[0].diagnostics = [];
    (templates[0].virtualDocument as Record<string, unknown>).mappings = [];
    manifest.symbols = [];
    writeManifest(workspace.root, manifest);
    const result = loadEtaLanguageSupportManifest(workspace.root);
    expect(result.status).toBe("loaded");
  });

  it("rejects manifests larger than the hard size limit", () => {
    const workspace = createWorkspace();
    fs.writeFileSync(
      path.join(workspace.root, ETA_LANGUAGE_SUPPORT_MANIFEST),
      " ".repeat(MAX_MANIFEST_BYTES + 1),
    );
    expect(loadEtaLanguageSupportManifest(workspace.root)).toMatchObject({
      status: "invalid",
    });
  });

  it("registers and ships the versioned JSON schema", () => {
    const packageJson = JSON.parse(
      fs.readFileSync(path.resolve("package.json"), "utf8"),
    ) as {
      contributes: {
        jsonValidation: Array<{ fileMatch: string; url: string }>;
      };
    };
    const schema = JSON.parse(
      fs.readFileSync(
        path.resolve("schemas", "eta-language-support.schema.json"),
        "utf8",
      ),
    ) as {
      additionalProperties: boolean;
      properties: { version: { const: number } };
    };

    expect(packageJson.contributes.jsonValidation).toContainEqual({
      fileMatch: ETA_LANGUAGE_SUPPORT_MANIFEST,
      url: "./schemas/eta-language-support.schema.json",
    });
    expect(schema.additionalProperties).toBe(false);
    expect(schema.properties.version.const).toBe(1);
  });

});

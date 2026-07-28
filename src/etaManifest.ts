import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import * as ts from "typescript";
import {
  EtaLanguageOptions,
  EtaTrimMode,
  normalizeEtaLanguageOptions,
} from "./etaConfig";

export const ETA_LANGUAGE_SUPPORT_MANIFEST = ".eta-language-support.json";
const ETA_LANGUAGE_SUPPORT_MANIFEST_VERSION = 1;
export const MAX_MANIFEST_BYTES = 5 * 1024 * 1024;

const HASH_PATTERN = /^[a-f0-9]{64}$/;
const IDENTIFIER_PATTERN = /^[A-Za-z_$][\w$]*$/;
const MAX_TEXT_LENGTH = 2 * 1024 * 1024;
const MAX_PATH_LENGTH = 4096;
const MAX_COLLECTION_LENGTH = 100_000;

export interface EtaManifestLocation {
  fileName: string;
  start: number;
  length: number;
}

export interface EtaManifestDataDefinition extends EtaManifestLocation {
  dataPath: string[];
}

export interface EtaManifestDiagnostic {
  start: number;
  length: number;
  severity: "error" | "warning" | "information" | "hint";
  source: string;
  message: string;
}

export interface EtaManifestMapping {
  sourceStart: number;
  sourceLength: number;
  virtualStart: number;
  virtualLength: number;
}

export interface EtaManifestVirtualDocument {
  content: string;
  mappings: EtaManifestMapping[];
  mappingsByVirtual: EtaManifestMapping[];
}

export interface EtaManifestResolutionOptions {
  views?: string;
  defaultExtension: string;
}

export interface EtaManifestTemplate {
  fileName: string;
  sha256: string;
  options: EtaLanguageOptions;
  dataType: string;
  dataDefinitions: EtaManifestDataDefinition[];
  resolution: EtaManifestResolutionOptions;
  relationships: string[];
  diagnostics: EtaManifestDiagnostic[];
  virtualDocument: EtaManifestVirtualDocument;
}

export interface EtaManifestTemplateName {
  name: string;
  fileName: string;
  definition?: EtaManifestLocation;
}

export interface EtaManifestSymbolOccurrence extends EtaManifestLocation {
  role: "definition" | "reference";
}

export interface EtaManifestSymbol {
  id: string;
  occurrences: EtaManifestSymbolOccurrence[];
}

export interface EtaLanguageSupportManifest {
  root: string;
  fileName: string;
  templates: Map<string, EtaManifestTemplate>;
  templateNames: Map<string, EtaManifestTemplateName>;
  symbols: EtaManifestSymbol[];
  relationships: Map<string, Set<string>>;
}

export type EtaManifestLoadResult =
  | { status: "missing"; messages: string[] }
  | { status: "invalid" | "stale"; messages: string[] }
  | {
      status: "loaded";
      manifest: EtaLanguageSupportManifest;
      messages: string[];
    };

class ManifestError extends Error {
  constructor(
    readonly kind: "invalid" | "stale",
    message: string,
  ) {
    super(message);
  }
}

function invalid(message: string): never {
  throw new ManifestError("invalid", message);
}

function stale(message: string): never {
  throw new ManifestError("stale", message);
}

function pathKey(fileName: string): string {
  const normalized = path.normalize(fileName);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}


function assertRecord(
  value: unknown,
  label: string,
  allowed?: readonly string[],
  required: readonly string[] = allowed ?? [],
): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    invalid(`${label} must be an object`);
  }
  const object = value as Record<string, unknown>;
  if (allowed) {
    const allowedSet = new Set(allowed);
    for (const key of Object.keys(object)) {
      if (!allowedSet.has(key)) {
        invalid(`${label} contains unknown property ${key}`);
      }
    }
  }
  for (const key of required) {
    if (!Object.hasOwn(object, key)) {
      invalid(`${label}.${key} is required`);
    }
  }
  return object;
}

function assertArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) invalid(`${label} must be an array`);
  if (value.length > MAX_COLLECTION_LENGTH) {
    invalid(`${label} exceeds ${MAX_COLLECTION_LENGTH} entries`);
  }
  return value;
}

function assertString(
  value: unknown,
  label: string,
  options: { allowEmpty?: boolean; maxLength?: number } = {},
): string {
  if (typeof value !== "string") invalid(`${label} must be a string`);
  const maxLength = options.maxLength ?? MAX_TEXT_LENGTH;
  if (value.length > maxLength) invalid(`${label} exceeds ${maxLength} characters`);
  if (!options.allowEmpty && value.length === 0) invalid(`${label} must not be empty`);
  return value;
}

function assertBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") invalid(`${label} must be a boolean`);
  return value;
}

function assertInteger(
  value: unknown,
  label: string,
  minimum = 0,
): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) {
    invalid(`${label} must be a safe integer >= ${minimum}`);
  }
  return value as number;
}

function assertSha256(value: unknown, label: string): string {
  const hash = assertString(value, label, { maxLength: 64 });
  if (!HASH_PATTERN.test(hash)) invalid(`${label} must be a lowercase SHA-256 hash`);
  return hash;
}

function assertStrings(value: unknown, label: string): string[] {
  return assertArray(value, label).map((item, index) =>
    assertString(item, `${label}[${index}]`, { maxLength: 256 }),
  );
}

function assertUniqueStrings(value: unknown, label: string): string[] {
  const values = assertStrings(value, label);
  if (new Set(values).size !== values.length) invalid(`${label} contains duplicates`);
  return values;
}

function realWorkspaceRoot(root: string): string {
  try {
    return fs.realpathSync(root);
  } catch {
    invalid(`Workspace root does not exist: ${root}`);
  }
}

function isContained(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function resolveContainedPath(
  root: string,
  value: unknown,
  label: string,
  expected: "file" | "directory" = "file",
): string {
  const relativePath = assertString(value, label, { maxLength: MAX_PATH_LENGTH });
  if (
    relativePath.includes("\\") ||
    relativePath.includes("\0") ||
    path.posix.isAbsolute(relativePath) ||
    path.posix.normalize(relativePath) !== relativePath ||
    relativePath === "." ||
    relativePath.startsWith("../")
  ) {
    invalid(`${label} must be a normalized workspace-relative POSIX path`);
  }
  const candidate = path.resolve(root, ...relativePath.split("/"));
  if (!isContained(root, candidate)) invalid(`${label} escapes the workspace root`);
  let resolved: string;
  try {
    resolved = fs.realpathSync(candidate);
  } catch {
    stale(`${label} does not exist: ${relativePath}`);
  }
  if (!isContained(root, resolved)) invalid(`${label} resolves outside the workspace root`);
  const stats = fs.statSync(resolved);
  if (expected === "file" ? !stats.isFile() : !stats.isDirectory()) {
    invalid(`${label} must reference a ${expected}`);
  }
  return resolved;
}

function readFileText(fileName: string): string {
  try {
    return fs.readFileSync(fileName, "utf8");
  } catch {
    stale(`Unable to read manifest input ${fileName}`);
  }
}

export function sha256Text(value: string): string {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

function sha256File(fileName: string): string {
  try {
    return crypto.createHash("sha256").update(fs.readFileSync(fileName)).digest("hex");
  } catch {
    stale(`Unable to hash manifest input ${fileName}`);
  }
}

function assertFreshFile(fileName: string, expected: string, label: string): void {
  if (sha256File(fileName) !== expected) stale(`${label} hash is stale`);
}

function parseTrimMode(value: unknown, label: string): EtaTrimMode {
  if (value === false || value === "nl" || value === "slurp") return value;
  return invalid(`${label} must be false, "nl", or "slurp"`);
}

function parseOptions(value: unknown, label: string): EtaLanguageOptions {
  const object = assertRecord(value, label, [
    "tags",
    "parse",
    "customTags",
    "customTagTypes",
    "varName",
    "useWith",
    "functionHeader",
    "outputFunctionName",
    "async",
    "autoEscape",
    "autoFilter",
    "autoTrim",
    "rmWhitespace",
  ]);
  const tags = assertArray(object.tags, `${label}.tags`);
  if (tags.length !== 2) invalid(`${label}.tags must contain exactly two entries`);
  const open = assertString(tags[0], `${label}.tags[0]`, { maxLength: 64 });
  const close = assertString(tags[1], `${label}.tags[1]`, { maxLength: 64 });
  const parse = assertRecord(object.parse, `${label}.parse`, [
    "exec",
    "interpolate",
    "raw",
  ]);
  const customTags = assertUniqueStrings(object.customTags, `${label}.customTags`);
  const customTagTypes = assertRecord(
    object.customTagTypes,
    `${label}.customTagTypes`,
  );
  const parsedCustomTagTypes: Record<string, "javascript" | "text"> = {};
  for (const [prefix, type] of Object.entries(customTagTypes)) {
    if (!prefix || prefix.length > 256 || (type !== "javascript" && type !== "text")) {
      invalid(`${label}.customTagTypes contains invalid metadata for ${prefix}`);
    }
    parsedCustomTagTypes[prefix] = type;
  }
  const varName = assertString(object.varName, `${label}.varName`, {
    maxLength: 256,
  });
  const outputFunctionName = assertString(
    object.outputFunctionName,
    `${label}.outputFunctionName`,
    { maxLength: 256 },
  );
  if (!IDENTIFIER_PATTERN.test(varName)) invalid(`${label}.varName must be an identifier`);
  if (!IDENTIFIER_PATTERN.test(outputFunctionName)) {
    invalid(`${label}.outputFunctionName must be an identifier`);
  }
  let autoTrim: EtaTrimMode | [EtaTrimMode, EtaTrimMode];
  if (Array.isArray(object.autoTrim)) {
    if (object.autoTrim.length !== 2) {
      invalid(`${label}.autoTrim must contain exactly two entries`);
    }
    autoTrim = [
      parseTrimMode(object.autoTrim[0], `${label}.autoTrim[0]`),
      parseTrimMode(object.autoTrim[1], `${label}.autoTrim[1]`),
    ];
  } else {
    autoTrim = parseTrimMode(object.autoTrim, `${label}.autoTrim`);
  }
  return normalizeEtaLanguageOptions({
    tags: [open, close],
    parse: {
      exec: assertString(parse.exec, `${label}.parse.exec`, {
        allowEmpty: true,
        maxLength: 256,
      }),
      interpolate: assertString(parse.interpolate, `${label}.parse.interpolate`, {
        allowEmpty: true,
        maxLength: 256,
      }),
      raw: assertString(parse.raw, `${label}.parse.raw`, {
        allowEmpty: true,
        maxLength: 256,
      }),
    },
    customTags,
    customTagTypes: parsedCustomTagTypes,
    varName,
    useWith: assertBoolean(object.useWith, `${label}.useWith`),
    functionHeader: assertString(object.functionHeader, `${label}.functionHeader`, {
      allowEmpty: true,
    }),
    outputFunctionName,
    async: assertBoolean(object.async, `${label}.async`),
    autoEscape: assertBoolean(object.autoEscape, `${label}.autoEscape`),
    autoFilter: assertBoolean(object.autoFilter, `${label}.autoFilter`),
    autoTrim,
    rmWhitespace: assertBoolean(object.rmWhitespace, `${label}.rmWhitespace`),
  });
}

function parseLocation(
  value: unknown,
  root: string,
  label: string,
): EtaManifestLocation {
  const object = assertRecord(value, label, ["path", "start", "length"]);
  const fileName = resolveContainedPath(root, object.path, `${label}.path`);
  const start = assertInteger(object.start, `${label}.start`);
  const length = assertInteger(object.length, `${label}.length`);
  const content = readFileText(fileName);
  if (start + length > content.length) invalid(`${label} is outside its source file`);
  return { fileName, start, length };
}

function parseMappings(
  value: unknown,
  sourceLength: number,
  virtualLength: number,
  label: string,
): EtaManifestVirtualDocument["mappings"] {
  const mappings = assertArray(value, label).map((item, index) => {
    const itemLabel = `${label}[${index}]`;
    const object = assertRecord(item, itemLabel, [
      "sourceStart",
      "sourceLength",
      "virtualStart",
      "virtualLength",
    ]);
    const mapping = {
      sourceStart: assertInteger(object.sourceStart, `${itemLabel}.sourceStart`),
      sourceLength: assertInteger(object.sourceLength, `${itemLabel}.sourceLength`, 1),
      virtualStart: assertInteger(object.virtualStart, `${itemLabel}.virtualStart`),
      virtualLength: assertInteger(object.virtualLength, `${itemLabel}.virtualLength`, 1),
    };
    if (mapping.sourceStart + mapping.sourceLength > sourceLength) {
      invalid(`${itemLabel} exceeds the template source`);
    }
    if (mapping.virtualStart + mapping.virtualLength > virtualLength) {
      invalid(`${itemLabel} exceeds the virtual document`);
    }
    return mapping;
  });
  const assertNonOverlapping = (
    sorted: EtaManifestMapping[],
    start: (mapping: EtaManifestMapping) => number,
    length: (mapping: EtaManifestMapping) => number,
    axis: string,
  ): void => {
    for (let index = 1; index < sorted.length; index++) {
      const previous = sorted[index - 1];
      const current = sorted[index];
      if (start(previous) + length(previous) > start(current)) {
        invalid(`${label} contains overlapping ${axis} ranges`);
      }
    }
  };
  const bySource = [...mappings].sort(
    (left, right) => left.sourceStart - right.sourceStart,
  );
  const byVirtual = [...mappings].sort(
    (left, right) => left.virtualStart - right.virtualStart,
  );
  assertNonOverlapping(bySource, (item) => item.sourceStart, (item) => item.sourceLength, "source");
  assertNonOverlapping(byVirtual, (item) => item.virtualStart, (item) => item.virtualLength, "virtual");
  return bySource;
}

function validateDataType(value: unknown, label: string): string {
  const dataType = assertString(value, label);
  const source = `type __EtaManifestData = ${dataType};`;
  const sourceFile = ts.createSourceFile(
    "eta-manifest-data.ts",
    source,
    ts.ScriptTarget.ES2020,
    true,
    ts.ScriptKind.TS,
  );
  const result = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2020 },
    reportDiagnostics: true,
  });
  if (
    result.diagnostics?.some(
      (diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error,
    ) ||
    sourceFile.statements.length !== 1 ||
    !ts.isTypeAliasDeclaration(sourceFile.statements[0]) ||
    sourceFile.statements[0].name.text !== "__EtaManifestData"
  ) {
    invalid(`${label} is not valid TypeScript type syntax`);
  }
  return dataType;
}

function parseTemplate(
  value: unknown,
  root: string,
  label: string,
): EtaManifestTemplate {
  const object = assertRecord(value, label, [
    "path",
    "sha256",
    "options",
    "dataType",
    "dataDefinitions",
    "resolution",
    "relationships",
    "diagnostics",
    "virtualDocument",
  ]);
  const fileName = resolveContainedPath(root, object.path, `${label}.path`);
  if (path.extname(fileName).toLowerCase() !== ".eta") {
    invalid(`${label}.path must reference an .eta template`);
  }
  const hash = assertSha256(object.sha256, `${label}.sha256`);
  assertFreshFile(fileName, hash, `${label}.sha256`);
  const source = readFileText(fileName);
  const definitions = assertArray(
    object.dataDefinitions,
    `${label}.dataDefinitions`,
  ).map((definition, index): EtaManifestDataDefinition => {
    const definitionLabel = `${label}.dataDefinitions[${index}]`;
    const definitionObject = assertRecord(definition, definitionLabel, [
      "dataPath",
      "location",
    ]);
    const dataPath = assertStrings(
      definitionObject.dataPath,
      `${definitionLabel}.dataPath`,
    );
    return {
      dataPath,
      ...parseLocation(
        definitionObject.location,
        root,
        `${definitionLabel}.location`,
      ),
    };
  });
  const resolutionObject = assertRecord(
    object.resolution,
    `${label}.resolution`,
    ["views", "defaultExtension"],
  );
  const views =
    resolutionObject.views === null
      ? undefined
      : resolveContainedPath(
          root,
          resolutionObject.views,
          `${label}.resolution.views`,
          "directory",
        );
  const defaultExtension = assertString(
    resolutionObject.defaultExtension,
    `${label}.resolution.defaultExtension`,
    { maxLength: 64 },
  );
  if (!defaultExtension.startsWith(".")) {
    invalid(`${label}.resolution.defaultExtension must start with a dot`);
  }
  const diagnostics = assertArray(
    object.diagnostics,
    `${label}.diagnostics`,
  ).map((diagnostic, index): EtaManifestDiagnostic => {
    const diagnosticLabel = `${label}.diagnostics[${index}]`;
    const diagnosticObject = assertRecord(diagnostic, diagnosticLabel, [
      "start",
      "length",
      "severity",
      "source",
      "message",
    ]);
    const start = assertInteger(diagnosticObject.start, `${diagnosticLabel}.start`);
    const length = assertInteger(diagnosticObject.length, `${diagnosticLabel}.length`);
    if (start + length > source.length) invalid(`${diagnosticLabel} exceeds the template source`);
    const severity = assertString(
      diagnosticObject.severity,
      `${diagnosticLabel}.severity`,
      { maxLength: 32 },
    );
    if (
      severity !== "error" &&
      severity !== "warning" &&
      severity !== "information" &&
      severity !== "hint"
    ) {
      invalid(`${diagnosticLabel}.severity is invalid`);
    }
    return {
      start,
      length,
      severity,
      source: assertString(diagnosticObject.source, `${diagnosticLabel}.source`, {
        maxLength: 256,
      }),
      message: assertString(diagnosticObject.message, `${diagnosticLabel}.message`),
    };
  });
  const virtualObject = assertRecord(
    object.virtualDocument,
    `${label}.virtualDocument`,
    ["content", "mappings"],
  );
  const virtualContent = assertString(
    virtualObject.content,
    `${label}.virtualDocument.content`,
  );
  const mappings = parseMappings(
    virtualObject.mappings,
    source.length,
    virtualContent.length,
    `${label}.virtualDocument.mappings`,
  );
  if (mappings.length === 0) invalid(`${label}.virtualDocument.mappings must not be empty`);
  return {
    fileName,
    sha256: hash,
    options: parseOptions(object.options, `${label}.options`),
    dataType: validateDataType(object.dataType, `${label}.dataType`),
    dataDefinitions: definitions,
    resolution: { views, defaultExtension },
    relationships: assertUniqueStrings(
      object.relationships,
      `${label}.relationships`,
    ).map((relationship, index) =>
      resolveContainedPath(root, relationship, `${label}.relationships[${index}]`),
    ),
    diagnostics,
    virtualDocument: {
      content: virtualContent,
      mappings,
      mappingsByVirtual: [...mappings].sort(
        (left, right) => left.virtualStart - right.virtualStart,
      ),
    },
  };
}

function validateManifestInputs(value: unknown, root: string): void {
  for (const [index, input] of assertArray(
    value,
    "manifest.inputs",
  ).entries()) {
    const label = `manifest.inputs[${index}]`;
    const inputObject = assertRecord(input, label, ["path", "sha256"]);
    const inputFile = resolveContainedPath(
      root,
      inputObject.path,
      `${label}.path`,
    );
    assertFreshFile(
      inputFile,
      assertSha256(inputObject.sha256, `${label}.sha256`),
      `${label}.sha256`,
    );
  }
}

function parseManifestTemplates(
  value: unknown,
  root: string,
): Map<string, EtaManifestTemplate> {
  const templates = new Map<string, EtaManifestTemplate>();
  for (const [index, templateValue] of assertArray(
    value,
    "manifest.templates",
  ).entries()) {
    const template = parseTemplate(
      templateValue,
      root,
      `manifest.templates[${index}]`,
    );
    const key = pathKey(template.fileName);
    if (templates.has(key)) {
      invalid(
        `manifest.templates contains duplicate path ${template.fileName}`,
      );
    }
    templates.set(key, template);
  }
  return templates;
}

function validateTemplateRelationships(
  templates: Map<string, EtaManifestTemplate>,
  knownTemplatePaths: Set<string>,
): void {
  for (const template of templates.values()) {
    for (const related of template.relationships) {
      if (!knownTemplatePaths.has(pathKey(related))) {
        invalid(
          `Template relationship does not reference a declared template: ${related}`,
        );
      }
    }
  }
}

function parseManifestTemplateNames(
  value: unknown,
  root: string,
  knownTemplatePaths: Set<string>,
): Map<string, EtaManifestTemplateName> {
  const templateNames = new Map<string, EtaManifestTemplateName>();
  for (const [index, nameValue] of assertArray(
    value,
    "manifest.templateNames",
  ).entries()) {
    const label = `manifest.templateNames[${index}]`;
    const nameObject = assertRecord(
      nameValue,
      label,
      ["name", "template", "definition"],
      ["name", "template"],
    );
    const name = assertString(nameObject.name, `${label}.name`, {
      maxLength: 1024,
    });
    if (templateNames.has(name)) {
      invalid(`manifest.templateNames contains duplicate name ${name}`);
    }
    const target = resolveContainedPath(
      root,
      nameObject.template,
      `${label}.template`,
    );
    if (!knownTemplatePaths.has(pathKey(target))) {
      invalid(`${label}.template does not reference a declared template`);
    }
    const definition =
      nameObject.definition === undefined
        ? undefined
        : parseLocation(nameObject.definition, root, `${label}.definition`);
    templateNames.set(name, { name, fileName: target, definition });
  }
  return templateNames;
}

interface OwnedManifestSymbolOccurrence {
  occurrence: EtaManifestSymbolOccurrence;
  label: string;
}

function parseManifestSymbolOccurrence(
  value: unknown,
  root: string,
  label: string,
  ownedOccurrences: OwnedManifestSymbolOccurrence[],
): EtaManifestSymbolOccurrence {
  const occurrenceObject = assertRecord(value, label, [
    "path",
    "start",
    "length",
    "role",
  ]);
  const location = parseLocation(
    {
      path: occurrenceObject.path,
      start: occurrenceObject.start,
      length: occurrenceObject.length,
    },
    root,
    label,
  );
  if (location.length === 0) invalid(`${label}.length must be positive`);
  const role = assertString(occurrenceObject.role, `${label}.role`, {
    maxLength: 32,
  });
  if (role !== "definition" && role !== "reference") {
    invalid(`${label}.role is invalid`);
  }
  const occurrence: EtaManifestSymbolOccurrence = { ...location, role };
  ownedOccurrences.push({ occurrence, label });
  return occurrence;
}

function parseManifestSymbol(
  value: unknown,
  index: number,
  root: string,
  symbolIds: Set<string>,
  ownedOccurrences: OwnedManifestSymbolOccurrence[],
): EtaManifestSymbol {
  const label = `manifest.symbols[${index}]`;
  const symbolObject = assertRecord(value, label, ["id", "occurrences"]);
  const id = assertString(symbolObject.id, `${label}.id`, {
    maxLength: 1024,
  });
  if (symbolIds.has(id)) {
    invalid(`manifest.symbols contains duplicate id ${id}`);
  }
  symbolIds.add(id);
  const occurrences = assertArray(
    symbolObject.occurrences,
    `${label}.occurrences`,
  ).map((occurrence, occurrenceIndex) =>
    parseManifestSymbolOccurrence(
      occurrence,
      root,
      `${label}.occurrences[${occurrenceIndex}]`,
      ownedOccurrences,
    ),
  );
  if (occurrences.length === 0) {
    invalid(`${label}.occurrences must not be empty`);
  }
  return { id, occurrences };
}

function validateSymbolOwnership(
  ownedOccurrences: OwnedManifestSymbolOccurrence[],
): void {
  ownedOccurrences.sort((left, right) => {
    const fileComparison = pathKey(left.occurrence.fileName).localeCompare(
      pathKey(right.occurrence.fileName),
    );
    return fileComparison || left.occurrence.start - right.occurrence.start;
  });
  for (let index = 1; index < ownedOccurrences.length; index++) {
    const previous = ownedOccurrences[index - 1].occurrence;
    const current = ownedOccurrences[index].occurrence;
    if (
      pathKey(previous.fileName) === pathKey(current.fileName) &&
      previous.start + previous.length > current.start
    ) {
      invalid(
        `${ownedOccurrences[index].label} overlaps an occurrence owned by another symbol`,
      );
    }
  }
}

function parseManifestSymbols(
  value: unknown,
  root: string,
): EtaManifestSymbol[] {
  const symbolIds = new Set<string>();
  const ownedOccurrences: OwnedManifestSymbolOccurrence[] = [];
  const symbols = assertArray(value, "manifest.symbols").map(
    (symbol, index) =>
      parseManifestSymbol(
        symbol,
        index,
        root,
        symbolIds,
        ownedOccurrences,
      ),
  );
  validateSymbolOwnership(ownedOccurrences);
  return symbols;
}

function addManifestRelationship(
  relationships: Map<string, Set<string>>,
  from: string,
  to: string,
): void {
  const key = pathKey(from);
  const related = relationships.get(key) ?? new Set<string>();
  related.add(pathKey(to));
  relationships.set(key, related);
}

function buildManifestRelationships(
  templates: Map<string, EtaManifestTemplate>,
): Map<string, Set<string>> {
  const relationships = new Map<string, Set<string>>();
  for (const template of templates.values()) {
    for (const related of template.relationships) {
      addManifestRelationship(relationships, template.fileName, related);
      addManifestRelationship(relationships, related, template.fileName);
    }
  }
  return relationships;
}

function parseManifest(
  value: unknown,
  root: string,
  fileName: string,
): EtaLanguageSupportManifest {
  const object = assertRecord(
    value,
    "manifest",
    ["$schema", "version", "inputs", "templates", "templateNames", "symbols"],
    ["version", "inputs", "templates", "templateNames", "symbols"],
  );
  if (object.$schema !== undefined) {
    assertString(object.$schema, "manifest.$schema", {
      maxLength: MAX_PATH_LENGTH,
    });
  }
  if (object.version !== ETA_LANGUAGE_SUPPORT_MANIFEST_VERSION) {
    invalid(
      `manifest.version must be ${ETA_LANGUAGE_SUPPORT_MANIFEST_VERSION}`,
    );
  }

  validateManifestInputs(object.inputs, root);
  const templates = parseManifestTemplates(object.templates, root);
  const knownTemplatePaths = new Set(templates.keys());
  validateTemplateRelationships(templates, knownTemplatePaths);
  const templateNames = parseManifestTemplateNames(
    object.templateNames,
    root,
    knownTemplatePaths,
  );
  const symbols = parseManifestSymbols(object.symbols, root);
  const relationships = buildManifestRelationships(templates);
  return { root, fileName, templates, templateNames, symbols, relationships };
}

export function loadEtaLanguageSupportManifest(root: string): EtaManifestLoadResult {
  const manifestPath = path.join(root, ETA_LANGUAGE_SUPPORT_MANIFEST);
  if (!fs.existsSync(manifestPath)) return { status: "missing", messages: [] };
  try {
    const realRoot = realWorkspaceRoot(root);
    const realManifest = fs.realpathSync(manifestPath);
    if (!isContained(realRoot, realManifest)) {
      invalid("Manifest file resolves outside the workspace root");
    }
    const stats = fs.statSync(realManifest);
    if (!stats.isFile()) invalid("Manifest path must be a file");
    if (stats.size > MAX_MANIFEST_BYTES) {
      invalid(`Manifest exceeds ${MAX_MANIFEST_BYTES} bytes`);
    }
    const source = fs.readFileSync(realManifest, "utf8");
    let value: unknown;
    try {
      value = JSON.parse(source) as unknown;
    } catch (error) {
      invalid(`Manifest is not valid JSON: ${String(error)}`);
    }
    return {
      status: "loaded",
      manifest: parseManifest(value, realRoot, realManifest),
      messages: [],
    };
  } catch (error) {
    if (error instanceof ManifestError) {
      return { status: error.kind, messages: [error.message] };
    }
    return { status: "invalid", messages: [String(error)] };
  }
}

function mapOffsetWithin(
  offset: number,
  fromStart: number,
  fromLength: number,
  toStart: number,
  toLength: number,
): number {
  if (offset === fromStart + fromLength) return toStart + toLength;
  const relative = offset - fromStart;
  return toStart + Math.min(toLength - 1, Math.floor((relative * toLength) / fromLength));
}

function findMapping(
  mappings: EtaManifestMapping[],
  offset: number,
  start: (mapping: EtaManifestMapping) => number,
  length: (mapping: EtaManifestMapping) => number,
): EtaManifestMapping | undefined {
  const exactStart = mappings.find((mapping) => start(mapping) === offset);
  if (exactStart) return exactStart;
  return mappings.find(
    (mapping) =>
      offset > start(mapping) && offset <= start(mapping) + length(mapping),
  );
}

export function sourceOffsetToVirtual(
  document: EtaManifestVirtualDocument,
  sourceOffset: number,
): number | undefined {
  const mapping = findMapping(
    document.mappings,
    sourceOffset,
    (item) => item.sourceStart,
    (item) => item.sourceLength,
  );
  return mapping
    ? mapOffsetWithin(
        sourceOffset,
        mapping.sourceStart,
        mapping.sourceLength,
        mapping.virtualStart,
        mapping.virtualLength,
      )
    : undefined;
}

export function virtualOffsetToSource(
  document: EtaManifestVirtualDocument,
  virtualOffset: number,
): number | undefined {
  const mapping = findMapping(
    document.mappingsByVirtual,
    virtualOffset,
    (item) => item.virtualStart,
    (item) => item.virtualLength,
  );
  return mapping
    ? mapOffsetWithin(
        virtualOffset,
        mapping.virtualStart,
        mapping.virtualLength,
        mapping.sourceStart,
        mapping.sourceLength,
      )
    : undefined;
}

export function sourceRangeToVirtual(
  document: EtaManifestVirtualDocument,
  start: number,
  length: number,
): { start: number; length: number } | undefined {
  const mapping = document.mappings.find(
    (candidate) =>
      start >= candidate.sourceStart &&
      start + length <= candidate.sourceStart + candidate.sourceLength,
  );
  if (!mapping) return undefined;
  const mappedStart = mapOffsetWithin(
    start,
    mapping.sourceStart,
    mapping.sourceLength,
    mapping.virtualStart,
    mapping.virtualLength,
  );
  const mappedEnd = mapOffsetWithin(
    start + length,
    mapping.sourceStart,
    mapping.sourceLength,
    mapping.virtualStart,
    mapping.virtualLength,
  );
  return { start: mappedStart, length: mappedEnd - mappedStart };
}

export function virtualRangeToSource(
  document: EtaManifestVirtualDocument,
  start: number,
  length: number,
): { start: number; length: number } | undefined {
  const mapping = document.mappingsByVirtual.find(
    (candidate) =>
      start >= candidate.virtualStart &&
      start + length <= candidate.virtualStart + candidate.virtualLength,
  );
  if (!mapping) return undefined;
  const mappedStart = mapOffsetWithin(
    start,
    mapping.virtualStart,
    mapping.virtualLength,
    mapping.sourceStart,
    mapping.sourceLength,
  );
  const mappedEnd = mapOffsetWithin(
    start + length,
    mapping.virtualStart,
    mapping.virtualLength,
    mapping.sourceStart,
    mapping.sourceLength,
  );
  return { start: mappedStart, length: mappedEnd - mappedStart };
}

export function getManifestTemplate(
  manifest: EtaLanguageSupportManifest,
  fileName: string,
  source?: string,
): EtaManifestTemplate | undefined {
  const template = manifest.templates.get(pathKey(fileName));
  if (!template) return undefined;
  if (source !== undefined && sha256Text(source) !== template.sha256) return undefined;
  return template;
}

export function getManifestSymbolAt(
  manifest: EtaLanguageSupportManifest,
  fileName: string,
  offset: number,
): EtaManifestSymbol | undefined {
  const key = pathKey(fileName);
  return manifest.symbols.find((symbol) =>
    symbol.occurrences.some(
      (occurrence) =>
        pathKey(occurrence.fileName) === key &&
        offset >= occurrence.start &&
        offset < occurrence.start + occurrence.length,
    ),
  );
}

export function areManifestTemplatesRelated(
  manifest: EtaLanguageSupportManifest,
  left: string,
  right: string,
): boolean {
  const leftKey = pathKey(left);
  const rightKey = pathKey(right);
  if (leftKey === rightKey) return true;
  const queue = [leftKey];
  const visited = new Set<string>();
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || visited.has(current)) continue;
    visited.add(current);
    for (const related of manifest.relationships.get(current) ?? []) {
      if (related === rightKey) return true;
      if (!visited.has(related)) queue.push(related);
    }
  }
  return false;
}

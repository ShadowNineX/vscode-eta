export interface EtaParseOptions {
  exec: string;
  interpolate: string;
  raw: string;
}

export type EtaTrimMode = "nl" | "slurp" | false;
export type EtaCustomTagType = "javascript" | "text";

export interface EtaLanguageOptions {
  tags: [string, string];
  parse: EtaParseOptions;
  customTags: string[];
  customTagTypes?: Record<string, EtaCustomTagType>;
  varName: string;
  useWith: boolean;
  functionHeader: string;
  outputFunctionName?: string;
  async?: boolean;
  autoEscape?: boolean;
  autoFilter?: boolean;
  autoTrim?: EtaTrimMode | [EtaTrimMode, EtaTrimMode];
  rmWhitespace?: boolean;
}

export const DEFAULT_ETA_LANGUAGE_OPTIONS: EtaLanguageOptions = {
  tags: ["<%", "%>"],
  parse: {
    exec: "",
    interpolate: "=",
    raw: "~",
  },
  customTags: [],
  varName: "it",
  useWith: false,
  functionHeader: "",
  customTagTypes: {},
  async: false,
  autoEscape: true,
  autoFilter: false,
  autoTrim: [false, "nl"],
  rmWhitespace: false,
  outputFunctionName: "output",
};

function asString(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

function asBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function asStringArray(value: unknown, fallback: string[]): string[] {
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === "string");
  }
  return value && typeof value === "object"
    ? Object.keys(value)
    : fallback;
}

function normalizeTags(value: unknown): [string, string] {
  let values: unknown[] = [];
  if (Array.isArray(value)) {
    values = value;
  } else if (value && typeof value === "object") {
    const tags = value as Record<string, unknown>;
    values = [tags.open, tags.close];
  }

  const [open, close] = values;
  return [
    asString(open, DEFAULT_ETA_LANGUAGE_OPTIONS.tags[0]) ||
      DEFAULT_ETA_LANGUAGE_OPTIONS.tags[0],
    asString(close, DEFAULT_ETA_LANGUAGE_OPTIONS.tags[1]) ||
      DEFAULT_ETA_LANGUAGE_OPTIONS.tags[1],
  ];
}

function applyNonDefaultParseOptions(
  result: EtaLanguageOptions,
  override: EtaLanguageOptions,
): void {
  if (override.parse.exec !== DEFAULT_ETA_LANGUAGE_OPTIONS.parse.exec) {
    result.parse.exec = override.parse.exec;
  }
  if (
    override.parse.interpolate !==
    DEFAULT_ETA_LANGUAGE_OPTIONS.parse.interpolate
  ) {
    result.parse.interpolate = override.parse.interpolate;
  }
  if (override.parse.raw !== DEFAULT_ETA_LANGUAGE_OPTIONS.parse.raw) {
    result.parse.raw = override.parse.raw;
  }
}

function asTrimMode(value: unknown): EtaTrimMode | undefined {
  return value === false || value === "nl" || value === "slurp"
    ? value
    : undefined;
}

function normalizeAutoTrim(
  value: unknown,
): EtaTrimMode | [EtaTrimMode, EtaTrimMode] {
  if (Array.isArray(value)) {
    const before = asTrimMode(value[0]);
    const after = asTrimMode(value[1]);
    if (before !== undefined && after !== undefined) return [before, after];
  }
  return (
    asTrimMode(value) ??
    DEFAULT_ETA_LANGUAGE_OPTIONS.autoTrim ??
    [false, "nl"]
  );
}

function normalizeCustomTagTypes(
  value: unknown,
): Record<string, EtaCustomTagType> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, EtaCustomTagType] =>
        entry[1] === "javascript" || entry[1] === "text",
    ),
  );
}

export function normalizeEtaLanguageOptions(
  value: unknown = {},
): EtaLanguageOptions {
  const config =
    value && typeof value === "object"
      ? (value as Record<string, unknown>)
      : {};
  const parse =
    config.parse && typeof config.parse === "object"
      ? (config.parse as Record<string, unknown>)
      : {};
  return {
    tags: normalizeTags(config.tags),
    parse: {
      exec: asString(parse.exec, DEFAULT_ETA_LANGUAGE_OPTIONS.parse.exec),
      interpolate: asString(
        parse.interpolate,
        DEFAULT_ETA_LANGUAGE_OPTIONS.parse.interpolate,
      ),
      raw: asString(parse.raw, DEFAULT_ETA_LANGUAGE_OPTIONS.parse.raw),
    },
    customTags: asStringArray(
      config.customTags,
      DEFAULT_ETA_LANGUAGE_OPTIONS.customTags,
    ),
    customTagTypes: normalizeCustomTagTypes(config.customTagTypes),
    varName:
      asString(config.varName, DEFAULT_ETA_LANGUAGE_OPTIONS.varName).trim() ||
      DEFAULT_ETA_LANGUAGE_OPTIONS.varName,
    useWith: asBoolean(config.useWith, DEFAULT_ETA_LANGUAGE_OPTIONS.useWith),
    functionHeader: asString(
      config.functionHeader,
      DEFAULT_ETA_LANGUAGE_OPTIONS.functionHeader,
    ),
    outputFunctionName:
      asString(
        config.outputFunctionName,
        DEFAULT_ETA_LANGUAGE_OPTIONS.outputFunctionName ?? "output",
      ).trim() || DEFAULT_ETA_LANGUAGE_OPTIONS.outputFunctionName,
    async: asBoolean(config.async, DEFAULT_ETA_LANGUAGE_OPTIONS.async ?? false),
    autoEscape: asBoolean(
      config.autoEscape,
      DEFAULT_ETA_LANGUAGE_OPTIONS.autoEscape ?? true,
    ),
    autoFilter: asBoolean(
      config.autoFilter,
      DEFAULT_ETA_LANGUAGE_OPTIONS.autoFilter ?? false,
    ),
    autoTrim: normalizeAutoTrim(config.autoTrim),
    rmWhitespace: asBoolean(
      config.rmWhitespace,
      DEFAULT_ETA_LANGUAGE_OPTIONS.rmWhitespace ?? false,
    ),
  };
}

function arraysEqual(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((item, index) => item === b[index]);
}

function tagsEqual(a: [string, string], b: [string, string]): boolean {
  return a[0] === b[0] && a[1] === b[1];
}

export function applyNonDefaultEtaLanguageOptions(
  base: EtaLanguageOptions,
  override: EtaLanguageOptions,
): EtaLanguageOptions {
  const normalizedBase = normalizeEtaLanguageOptions(base);
  const normalizedOverride = normalizeEtaLanguageOptions(override);
  const result: EtaLanguageOptions = {
    tags: [...normalizedBase.tags],
    parse: { ...normalizedBase.parse },
    customTags: [...normalizedBase.customTags],
    customTagTypes: { ...normalizedBase.customTagTypes },
    varName: normalizedBase.varName,
    useWith: normalizedBase.useWith,
    functionHeader: normalizedBase.functionHeader,
    async: normalizedBase.async,
    outputFunctionName: normalizedBase.outputFunctionName,
    autoEscape: normalizedBase.autoEscape,
    autoFilter: normalizedBase.autoFilter,
    autoTrim: Array.isArray(normalizedBase.autoTrim)
      ? [...normalizedBase.autoTrim]
      : normalizedBase.autoTrim,
    rmWhitespace: normalizedBase.rmWhitespace,
  };

  if (!tagsEqual(normalizedOverride.tags, DEFAULT_ETA_LANGUAGE_OPTIONS.tags)) {
    result.tags = [...normalizedOverride.tags];
  }
  applyNonDefaultParseOptions(result, normalizedOverride);
  if (
    !arraysEqual(
      normalizedOverride.customTags,
      DEFAULT_ETA_LANGUAGE_OPTIONS.customTags,
    )
  ) {
    result.customTags = [...normalizedOverride.customTags];
  }
  if (Object.keys(normalizedOverride.customTagTypes ?? {}).length > 0) {
    result.customTagTypes = { ...normalizedOverride.customTagTypes };
  }
  if (normalizedOverride.varName !== DEFAULT_ETA_LANGUAGE_OPTIONS.varName) {
    result.varName = normalizedOverride.varName;
  }
  if (normalizedOverride.useWith !== DEFAULT_ETA_LANGUAGE_OPTIONS.useWith) {
    result.useWith = normalizedOverride.useWith;
  }
  if (
    normalizedOverride.functionHeader !==
    DEFAULT_ETA_LANGUAGE_OPTIONS.functionHeader
  ) {
    result.functionHeader = normalizedOverride.functionHeader;
  }
  if (
    normalizedOverride.outputFunctionName !==
    DEFAULT_ETA_LANGUAGE_OPTIONS.outputFunctionName
  ) {
    result.outputFunctionName = normalizedOverride.outputFunctionName;
  }
  if (normalizedOverride.async !== DEFAULT_ETA_LANGUAGE_OPTIONS.async) {
    result.async = normalizedOverride.async;
  }
  if (
    normalizedOverride.autoEscape !== DEFAULT_ETA_LANGUAGE_OPTIONS.autoEscape
  ) {
    result.autoEscape = normalizedOverride.autoEscape;
  }
  if (
    normalizedOverride.autoFilter !== DEFAULT_ETA_LANGUAGE_OPTIONS.autoFilter
  ) {
    result.autoFilter = normalizedOverride.autoFilter;
  }
  if (
    JSON.stringify(normalizedOverride.autoTrim) !==
    JSON.stringify(DEFAULT_ETA_LANGUAGE_OPTIONS.autoTrim)
  ) {
    result.autoTrim = normalizedOverride.autoTrim;
  }
  if (
    normalizedOverride.rmWhitespace !==
    DEFAULT_ETA_LANGUAGE_OPTIONS.rmWhitespace
  ) {
    result.rmWhitespace = normalizedOverride.rmWhitespace;
  }

  return result;
}

export function getTagPrefixCandidates(options: EtaLanguageOptions): string[] {
  return [
    options.parse.interpolate,
    options.parse.raw,
    options.parse.exec,
    ...new Set([
      ...options.customTags,
      ...Object.keys(options.customTagTypes ?? {}),
    ]),
  ]
    .filter((prefix) => prefix.length > 0)
    .sort((a, b) => b.length - a.length);
}

export function isJavaScriptTagPrefix(
  prefix: string,
  options: EtaLanguageOptions,
): boolean {
  return (
    prefix === options.parse.exec ||
    prefix === options.parse.interpolate ||
    prefix === options.parse.raw ||
    options.customTagTypes?.[prefix] === "javascript"
  );
}

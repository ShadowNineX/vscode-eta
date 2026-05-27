export interface EtaParseOptions {
  exec: string;
  interpolate: string;
  raw: string;
}

export interface EtaLanguageOptions {
  tags: [string, string];
  parse: EtaParseOptions;
  customTags: string[];
  varName: string;
  useWith: boolean;
  functionHeader: string;
  outputFunctionName?: string;
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
  outputFunctionName: "output",
};

function asString(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

function asBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function asStringArray(value: unknown, fallback: string[]): string[] {
  if (!Array.isArray(value)) return fallback;
  return value.filter((item): item is string => typeof item === "string");
}

function normalizeTags(value: unknown): [string, string] {
  if (!Array.isArray(value)) return DEFAULT_ETA_LANGUAGE_OPTIONS.tags;
  const [open, close] = value;
  return [
    asString(open, DEFAULT_ETA_LANGUAGE_OPTIONS.tags[0]) ||
      DEFAULT_ETA_LANGUAGE_OPTIONS.tags[0],
    asString(close, DEFAULT_ETA_LANGUAGE_OPTIONS.tags[1]) ||
      DEFAULT_ETA_LANGUAGE_OPTIONS.tags[1],
  ];
}

export function normalizeEtaLanguageOptions(
  value: Partial<EtaLanguageOptions> = {},
): EtaLanguageOptions {
  return {
    tags: normalizeTags(value.tags),
    parse: {
      exec: asString(value.parse?.exec, DEFAULT_ETA_LANGUAGE_OPTIONS.parse.exec),
      interpolate: asString(
        value.parse?.interpolate,
        DEFAULT_ETA_LANGUAGE_OPTIONS.parse.interpolate,
      ),
      raw: asString(value.parse?.raw, DEFAULT_ETA_LANGUAGE_OPTIONS.parse.raw),
    },
    customTags: asStringArray(
      value.customTags,
      DEFAULT_ETA_LANGUAGE_OPTIONS.customTags,
    ),
    varName:
      asString(value.varName, DEFAULT_ETA_LANGUAGE_OPTIONS.varName).trim() ||
      DEFAULT_ETA_LANGUAGE_OPTIONS.varName,
    useWith: asBoolean(value.useWith, DEFAULT_ETA_LANGUAGE_OPTIONS.useWith),
    functionHeader: asString(
      value.functionHeader,
      DEFAULT_ETA_LANGUAGE_OPTIONS.functionHeader,
    ),
    outputFunctionName:
      asString(
        value.outputFunctionName,
        DEFAULT_ETA_LANGUAGE_OPTIONS.outputFunctionName ?? "output",
      ).trim() || DEFAULT_ETA_LANGUAGE_OPTIONS.outputFunctionName,
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
  const result: EtaLanguageOptions = {
    tags: [...base.tags],
    parse: { ...base.parse },
    customTags: [...base.customTags],
    varName: base.varName,
    useWith: base.useWith,
    functionHeader: base.functionHeader,
    outputFunctionName: base.outputFunctionName,
  };

  if (!tagsEqual(override.tags, DEFAULT_ETA_LANGUAGE_OPTIONS.tags)) {
    result.tags = [...override.tags];
  }
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
  if (
    !arraysEqual(override.customTags, DEFAULT_ETA_LANGUAGE_OPTIONS.customTags)
  ) {
    result.customTags = [...override.customTags];
  }
  if (override.varName !== DEFAULT_ETA_LANGUAGE_OPTIONS.varName) {
    result.varName = override.varName;
  }
  if (override.useWith !== DEFAULT_ETA_LANGUAGE_OPTIONS.useWith) {
    result.useWith = override.useWith;
  }
  if (override.functionHeader !== DEFAULT_ETA_LANGUAGE_OPTIONS.functionHeader) {
    result.functionHeader = override.functionHeader;
  }
  if (
    (override.outputFunctionName ??
      DEFAULT_ETA_LANGUAGE_OPTIONS.outputFunctionName) !==
    DEFAULT_ETA_LANGUAGE_OPTIONS.outputFunctionName
  ) {
    result.outputFunctionName = override.outputFunctionName;
  }

  return result;
}

export function getTagPrefixCandidates(options: EtaLanguageOptions): string[] {
  return [
    options.parse.interpolate,
    options.parse.raw,
    options.parse.exec,
    ...options.customTags,
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
    prefix === options.parse.raw
  );
}

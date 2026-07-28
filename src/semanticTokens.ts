import ts from "typescript";
import { consumeTagOpener, findEtaTagRanges } from "./etaScanner";
import {
  isJavaScriptTagPrefix,
  type EtaLanguageOptions,
} from "./etaConfig";
import {
  virtualRangeToSource,
  type EtaManifestVirtualDocument,
} from "./etaManifest";

export const ETA_SEMANTIC_TOKEN_TYPES = [
  "comment",
  "string",
  "keyword",
  "number",
  "regexp",
  "operator",
  "variable",
  "parameter",
  "property",
  "function",
  "method",
  "class",
  "interface",
  "enum",
  "enumMember",
  "namespace",
  "type",
  "typeParameter",
] as const;

export interface EtaSemanticToken {
  start: number;
  length: number;
  tokenType: number;
}

interface SourceSpan {
  start: number;
  end: number;
}

const tokenTypeIndexes = new Map<string, number>(
  ETA_SEMANTIC_TOKEN_TYPES.map((tokenType, index) => [tokenType, index]),
);
const TYPESCRIPT_SEMANTIC_TOKEN_TYPES = [
  "class",
  "enum",
  "interface",
  "namespace",
  "typeParameter",
  "type",
  "parameter",
  "variable",
  "enumMember",
  "property",
  "function",
  "method",
] as const;

function tokenTypeForSemanticClassification(
  classification: number,
): number | undefined {
  const semanticIndex = (classification >> 8) - 1;
  const tokenType = TYPESCRIPT_SEMANTIC_TOKEN_TYPES[semanticIndex];
  return tokenType === undefined
    ? undefined
    : tokenTypeIndexes.get(tokenType);
}

function tokenTypeForClassification(
  classification: ts.ClassificationType,
): number | undefined {
  let tokenType: (typeof ETA_SEMANTIC_TOKEN_TYPES)[number] | undefined;
  switch (classification) {
    case ts.ClassificationType.comment:
    case ts.ClassificationType.docCommentTagName:
      tokenType = "comment";
      break;
    case ts.ClassificationType.stringLiteral:
    case ts.ClassificationType.jsxAttributeStringLiteralValue:
      tokenType = "string";
      break;
    case ts.ClassificationType.keyword:
      tokenType = "keyword";
      break;
    case ts.ClassificationType.numericLiteral:
    case ts.ClassificationType.bigintLiteral:
      tokenType = "number";
      break;
    case ts.ClassificationType.regularExpressionLiteral:
      tokenType = "regexp";
      break;
    case ts.ClassificationType.operator:
    case ts.ClassificationType.punctuation:
      tokenType = "operator";
      break;
    case ts.ClassificationType.className:
      tokenType = "class";
      break;
    case ts.ClassificationType.interfaceName:
      tokenType = "interface";
      break;
    case ts.ClassificationType.enumName:
      tokenType = "enum";
      break;
    case ts.ClassificationType.moduleName:
      tokenType = "namespace";
      break;
    case ts.ClassificationType.typeAliasName:
      tokenType = "type";
      break;
    case ts.ClassificationType.typeParameterName:
      tokenType = "typeParameter";
      break;
    case ts.ClassificationType.parameterName:
      tokenType = "parameter";
      break;
    case ts.ClassificationType.identifier:
    case ts.ClassificationType.jsxOpenTagName:
    case ts.ClassificationType.jsxCloseTagName:
    case ts.ClassificationType.jsxSelfClosingTagName:
    case ts.ClassificationType.jsxAttribute:
      tokenType = "variable";
      break;
    default:
      return undefined;
  }
  return tokenTypeIndexes.get(tokenType);
}

function getJavaScriptSpans(
  source: string,
  options: EtaLanguageOptions,
): SourceSpan[] {
  const spans: SourceSpan[] = [];
  for (const range of findEtaTagRanges(source, options)) {
    const opener = consumeTagOpener(source, range.start, options);
    if (!isJavaScriptTagPrefix(opener.prefix, options)) continue;
    let end = range.closed
      ? range.end - options.tags[1].length
      : range.end;
    if (end > range.contentStart && (source[end - 1] === "-" || source[end - 1] === "_")) {
      end--;
    }
    if (end > range.contentStart) {
      spans.push({ start: range.contentStart, end });
    }
  }
  return spans;
}

function isInsideMappedJavaScript(
  span: SourceSpan,
  javascriptSpans: SourceSpan[],
): boolean {
  return javascriptSpans.some(
    (javascript) => span.start >= javascript.start && span.end <= javascript.end,
  );
}

function addCustomTagTokens(
  tokens: EtaSemanticToken[],
  source: string,
  options: EtaLanguageOptions,
): void {
  const operator = tokenTypeIndexes.get("operator");
  if (operator === undefined) return;
  const customPrefixes = new Set([
    ...options.customTags,
    ...Object.keys(options.customTagTypes ?? {}),
  ]);
  for (const range of findEtaTagRanges(source, options)) {
    const opener = consumeTagOpener(source, range.start, options);
    if (!opener.prefix || !customPrefixes.has(opener.prefix)) continue;
    tokens.push({
      start: range.start,
      length: opener.next - range.start,
      tokenType: operator,
    });
  }
}

export function collectEtaSemanticTokens(
  languageService: ts.LanguageService,
  virtualPath: string,
  virtualDocument: EtaManifestVirtualDocument,
  source: string,
  options: EtaLanguageOptions,
): EtaSemanticToken[] {
  const javascriptSpans = getJavaScriptSpans(source, options);
  const tokens: EtaSemanticToken[] = [];
  const semanticClassifications =
    languageService.getEncodedSemanticClassifications(
      virtualPath,
      { start: 0, length: virtualDocument.content.length },
      ts.SemanticClassificationFormat.TwentyTwenty,
    ).spans;
  const semanticTokens = new Map<
    number,
    { length: number; tokenType: number }
  >();
  for (let index = 0; index < semanticClassifications.length; index += 3) {
    const tokenType = tokenTypeForSemanticClassification(
      semanticClassifications[index + 2],
    );
    if (tokenType === undefined) continue;
    semanticTokens.set(semanticClassifications[index], {
      length: semanticClassifications[index + 1],
      tokenType,
    });
  }

  const classifications = languageService.getEncodedSyntacticClassifications(
    virtualPath,
    { start: 0, length: virtualDocument.content.length },
  ).spans;

  for (let index = 0; index < classifications.length; index += 3) {
    const virtualStart = classifications[index];
    const virtualLength = classifications[index + 1];
    const classification = classifications[index + 2];
    let tokenType = tokenTypeForClassification(classification);
    const semanticToken = semanticTokens.get(virtualStart);
    if (semanticToken?.length === virtualLength) {
      tokenType = semanticToken.tokenType;
    }
    if (
      classification === ts.ClassificationType.stringLiteral &&
      virtualDocument.content[virtualStart] === "/"
    ) {
      tokenType = tokenTypeIndexes.get("regexp");
    }
    if (tokenType === undefined) continue;
    const sourceRange = virtualRangeToSource(
      virtualDocument,
      virtualStart,
      virtualLength,
    );
    if (!sourceRange) continue;
    const sourceSpan = {
      start: sourceRange.start,
      end: sourceRange.start + sourceRange.length,
    };
    if (!isInsideMappedJavaScript(sourceSpan, javascriptSpans)) continue;
    tokens.push({
      start: sourceRange.start,
      length: sourceRange.length,
      tokenType,
    });
  }

  addCustomTagTokens(tokens, source, options);
  let previousEnd = -1;
  return tokens
    .filter((token) => token.length > 0)
    .sort(
      (left, right) =>
        left.start - right.start || right.length - left.length,
    )
    .filter((token) => {
      if (token.start < previousEnd) return false;
      previousEnd = token.start + token.length;
      return true;
    });
}

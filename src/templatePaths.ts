import * as path from "node:path";
import * as ts from "typescript";

function withDefaultExtension(
  templateName: string,
  defaultExtension = ".eta",
): string {
  if (path.extname(templateName)) return templateName;
  const extension = defaultExtension.startsWith(".")
    ? defaultExtension
    : `.${defaultExtension}`;
  return `${templateName}${extension}`;
}

export function canonicalTemplatePath(fileName: string): string {
  const normalized = path.normalize(path.resolve(fileName));
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function isCanonicalPathWithinRoot(fileName: string, root: string): boolean {
  const relative = path.relative(root, fileName);
  return (
    relative === "" ||
    (relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative))
  );
}

export function isFileWithinRoot(fileName: string, root: string): boolean {
  return isCanonicalPathWithinRoot(
    canonicalTemplatePath(fileName),
    canonicalTemplatePath(root),
  );
}

export function findMostSpecificContainingRoot<T extends { root: string }>(
  fileName: string,
  candidates: Iterable<T>,
): T | undefined {
  const normalizedFileName = canonicalTemplatePath(fileName);
  let selected: T | undefined;
  let selectedRootLength = -1;
  for (const candidate of candidates) {
    const candidateRoot = canonicalTemplatePath(candidate.root);
    if (
      isCanonicalPathWithinRoot(normalizedFileName, candidateRoot) &&
      candidateRoot.length > selectedRootLength
    ) {
      selected = candidate;
      selectedRootLength = candidateRoot.length;
    }
  }
  return selected;
}

export interface TemplateResolutionContext {
  fromFile: string;
  views?: string;
  defaultExtension?: string;
  templateFiles: Iterable<string>;
}

export function resolveTemplatePath(
  templateName: string,
  context: TemplateResolutionContext,
): string | undefined {
  const nameWithExtension = withDefaultExtension(
    templateName,
    context.defaultExtension,
  );
  const knownFiles = [...context.templateFiles].map((fileName) => ({
    fileName,
    key: canonicalTemplatePath(fileName),
  }));
  const knownKeys = new Map(knownFiles.map((file) => [file.key, file.fileName]));
  const candidates: string[] = [];

  if (path.isAbsolute(nameWithExtension)) {
    candidates.push(nameWithExtension);
  } else {
    candidates.push(path.resolve(path.dirname(context.fromFile), nameWithExtension));
    if (context.views) {
      candidates.unshift(path.resolve(context.views, nameWithExtension));
    }
  }

  for (const candidate of candidates) {
    const known = knownKeys.get(canonicalTemplatePath(candidate));
    if (known) return canonicalTemplatePath(known);
    if (ts.sys.fileExists(candidate)) return canonicalTemplatePath(candidate);
  }

  const normalizedSuffix = path
    .normalize(nameWithExtension)
    .replaceAll("\\", "/")
    .toLowerCase();
  const suffixMatches = knownFiles.filter(({ fileName }) => {
    const normalized = path
      .normalize(fileName)
      .replaceAll("\\", "/")
      .toLowerCase();
    return (
      normalized === normalizedSuffix || normalized.endsWith(`/${normalizedSuffix}`)
    );
  });
  if (suffixMatches.length === 1) return suffixMatches[0].key;

  const basename = path.basename(normalizedSuffix);
  const basenameMatches = knownFiles.filter(
    ({ fileName }) => path.basename(fileName).toLowerCase() === basename,
  );
  if (basenameMatches.length === 1) return basenameMatches[0].key;

  return undefined;
}


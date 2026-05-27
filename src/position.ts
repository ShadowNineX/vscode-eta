import { findEtaTagRanges } from "./etaScanner";
import {
  DEFAULT_ETA_LANGUAGE_OPTIONS,
  EtaLanguageOptions,
} from "./etaConfig";

export function positionToOffset(
  content: string,
  line: number,
  character: number,
): number {
  const lines = content.split("\n");
  let offset = 0;
  for (let i = 0; i < line && i < lines.length; i++) {
    offset += lines[i].length + 1; // +1 for \n
  }
  return offset + character;
}

export function isInsideEtaTag(
  line: string,
  character: number,
  options: EtaLanguageOptions = DEFAULT_ETA_LANGUAGE_OPTIONS,
): boolean {
  return isInsideEtaTagInText(line, 0, character, options);
}

export function isInsideEtaTagInText(
  text: string,
  line: number,
  character: number,
  options: EtaLanguageOptions = DEFAULT_ETA_LANGUAGE_OPTIONS,
): boolean {
  const offset = positionToOffset(text, line, character);
  return findEtaTagRanges(text, options).some(
    (range) => offset >= range.contentStart && offset < range.end,
  );
}

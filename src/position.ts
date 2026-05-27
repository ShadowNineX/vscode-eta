import { findEtaTagRanges } from "./etaScanner";

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

export function isInsideEtaTag(line: string, character: number): boolean {
  return isInsideEtaTagInText(line, 0, character);
}

export function isInsideEtaTagInText(
  text: string,
  line: number,
  character: number,
): boolean {
  const offset = positionToOffset(text, line, character);
  return findEtaTagRanges(text).some(
    (range) => offset >= range.start + 2 && offset < range.end,
  );
}

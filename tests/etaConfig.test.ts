import { describe, expect, it } from "vitest";
import {
  DEFAULT_ETA_LANGUAGE_OPTIONS,
  applyNonDefaultEtaLanguageOptions,
  getTagPrefixCandidates,
  isJavaScriptTagPrefix,
  normalizeEtaLanguageOptions,
} from "../src/etaConfig";

describe("normalizeEtaLanguageOptions", () => {
  it("returns the Eta defaults when no settings are provided", () => {
    expect(normalizeEtaLanguageOptions()).toEqual(DEFAULT_ETA_LANGUAGE_OPTIONS);
    expect(normalizeEtaLanguageOptions().customTags).toEqual([]);
  });

  it("normalizes custom tags while filtering invalid values", () => {
    const options = normalizeEtaLanguageOptions({
      customTags: ["#", 1, "*", null, "@"] as unknown as string[],
    });

    expect(options.customTags).toEqual(["#", "*", "@"]);
  });

  it("falls back to default tags and varName for empty or invalid settings", () => {
    const options = normalizeEtaLanguageOptions({
      tags: ["", ""] as unknown as [string, string],
      varName: "   ",
    });

    expect(options.tags).toEqual(DEFAULT_ETA_LANGUAGE_OPTIONS.tags);
    expect(options.varName).toBe(DEFAULT_ETA_LANGUAGE_OPTIONS.varName);
  });

  it("keeps configured delimiters, parse prefixes, and runtime helpers", () => {
    const options = normalizeEtaLanguageOptions({
      tags: ["{{", "}}"],
      parse: {
        exec: "%",
        interpolate: ":",
        raw: "!",
      },
      customTags: ["#"],
      varName: "data",
      useWith: true,
      functionHeader: "const helper = data.user.name",
      outputFunctionName: "print",
    });

    expect(options.tags).toEqual(["{{", "}}"]);
    expect(options.parse).toEqual({
      exec: "%",
      interpolate: ":",
      raw: "!",
    });
    expect(options.customTags).toEqual(["#"]);
    expect(options.varName).toBe("data");
    expect(options.useWith).toBe(true);
    expect(options.functionHeader).toBe("const helper = data.user.name");
    expect(options.outputFunctionName).toBe("print");
  });
});

describe("applyNonDefaultEtaLanguageOptions", () => {
  it("keeps inferred options when editor settings are still defaults", () => {
    const inferred = normalizeEtaLanguageOptions({
      tags: ["{{", "}}"],
      varName: "data",
      outputFunctionName: "print",
    });

    expect(
      applyNonDefaultEtaLanguageOptions(
        inferred,
        DEFAULT_ETA_LANGUAGE_OPTIONS,
      ),
    ).toEqual(inferred);
  });

  it("lets non-default editor settings override inferred options", () => {
    const inferred = normalizeEtaLanguageOptions({
      tags: ["{{", "}}"],
      varName: "data",
    });
    const override = normalizeEtaLanguageOptions({
      varName: "view",
      outputFunctionName: "echo",
    });

    const merged = applyNonDefaultEtaLanguageOptions(inferred, override);
    expect(merged.tags).toEqual(["{{", "}}"]);
    expect(merged.varName).toBe("view");
    expect(merged.outputFunctionName).toBe("echo");
  });
});

describe("getTagPrefixCandidates", () => {
  it("sorts prefixes longest-first so multi-character prefixes win", () => {
    const options = normalizeEtaLanguageOptions({
      parse: {
        exec: "",
        interpolate: "::",
        raw: ":",
      },
      customTags: ["#", "###"],
    });

    expect(getTagPrefixCandidates(options)).toEqual(["###", "::", ":", "#"]);
  });
});

describe("isJavaScriptTagPrefix", () => {
  it("distinguishes parse prefixes from custom tag prefixes", () => {
    const options = normalizeEtaLanguageOptions({
      parse: {
        exec: "",
        interpolate: ":",
        raw: "!",
      },
      customTags: ["#"],
    });

    expect(isJavaScriptTagPrefix(":", options)).toBe(true);
    expect(isJavaScriptTagPrefix("!", options)).toBe(true);
    expect(isJavaScriptTagPrefix("#", options)).toBe(false);
  });
});

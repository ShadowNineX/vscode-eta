import { describe, expect, it } from "vitest";
import * as ts from "typescript";
import { Eta } from "eta";
import { normalizeEtaLanguageOptions } from "../src/etaConfig";
import { findEtaTagRanges } from "../src/etaScanner";
import { buildRuntimeVirtualDocument } from "../src/virtualDocument";

function runtimeSyntaxDiagnostics(
  template: string,
  config: unknown = {},
): readonly ts.Diagnostic[] {
  const virtual = buildRuntimeVirtualDocument(
    template,
    normalizeEtaLanguageOptions(config),
  );
  return (
    ts.transpileModule(virtual.content, {
      compilerOptions: {
        allowJs: true,
        checkJs: true,
        noEmit: true,
        target: ts.ScriptTarget.ES2020,
      },
      fileName: "eta-runtime-parity.js",
      reportDiagnostics: true,
    }).diagnostics ?? []
  );
}

describe("Eta 4.6 runtime parity", () => {
  it("matches multiline interpolation-prefix parsing", () => {
    const template = "<%\n= it.name %>";
    const eta = new Eta();

    expect(eta.renderString(template, { name: "Ada" })).toBe("Ada");
    expect(findEtaTagRanges(template)).toMatchObject([
      { closed: true, contentStart: 4 },
    ]);
    expect(runtimeSyntaxDiagnostics(template)).toEqual([]);
  });

  it("keeps delimiters inside strings and block comments", () => {
    const eta = new Eta();
    const stringTemplate = '<%= "%>" %>';
    const commentTemplate = "<% /* %> */ const value = 1; %><%= value %>";

    expect(eta.renderString(stringTemplate, {})).toBe("%&gt;");
    expect(eta.renderString(commentTemplate, {})).toBe("1");
    expect(findEtaTagRanges(stringTemplate)).toHaveLength(1);
    expect(findEtaTagRanges(commentTemplate)).toHaveLength(2);
    expect(runtimeSyntaxDiagnostics(stringTemplate)).toEqual([]);
    expect(runtimeSyntaxDiagnostics(commentTemplate)).toEqual([]);
  });

  it("inserts valid boundaries between adjacent execution tags", () => {
    const template =
      "<% const first = 1 %><% const second = 2 %><%= first + second %>";
    const eta = new Eta();

    expect(eta.renderString(template, {})).toBe("3");
    expect(findEtaTagRanges(template)).toHaveLength(3);
    expect(runtimeSyntaxDiagnostics(template)).toEqual([]);
  });

  it("matches Eta trim-marker output", () => {
    const eta = new Eta();
    const template = "A\n<%- const value = 1 %>\nB";

    expect(eta.renderString(template, {})).toBe("AB");
    expect(findEtaTagRanges(template)[0]).toMatchObject({ closed: true });
  });

  it("matches Eta's delimiter boundary inside regex literals", () => {
    const template = "<% const pattern = /a%>b/; %><%= pattern.source %>";
    const eta = new Eta();

    expect(() => eta.renderString(template, {})).toThrow(/Bad template syntax/);
    expect(findEtaTagRanges(template)[0].end).toBe(template.indexOf("%>") + 2);
    expect(runtimeSyntaxDiagnostics(template)).not.toEqual([]);
  });

  it("matches custom delimiters and parse prefixes", () => {
    const config = {
      tags: ["{{", "}}"] as [string, string],
      parse: { exec: "", interpolate: ":", raw: "!" },
    };
    const eta = new Eta(config);
    const template = "{{: it.name }}";

    expect(eta.renderString(template, { name: "Ada" })).toBe("Ada");
    expect(findEtaTagRanges(template, normalizeEtaLanguageOptions(config))).toHaveLength(1);
    expect(runtimeSyntaxDiagnostics(template, config)).toEqual([]);
  });

  it("matches async templates and automatic escaping", async () => {
    const asyncConfig = { async: true };
    const asyncEta = new Eta();
    const rawEta = new Eta({ autoEscape: false });

    await expect(
      asyncEta.renderStringAsync(
        "<%= await Promise.resolve(it.name) %>",
        { name: "Ada" },
      ),
    ).resolves.toBe("Ada");
    expect(rawEta.renderString('<%= "<b>" %>', {})).toBe("<b>");
    expect(
      runtimeSyntaxDiagnostics(
        "<%= await Promise.resolve(it.name) %>",
        asyncConfig,
      ),
    ).toEqual([]);
  });
});

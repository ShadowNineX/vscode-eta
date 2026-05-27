import { describe, it, expect } from "vitest";
import { tsKindToLSP } from "../src/lspKind";

// ── tsKindToLSP ──────────────────────────────────────────────────────────────



describe("tsKindToLSP", () => {

  it("maps 'function' → Function", () => {

    expect(tsKindToLSP("function")).toBe(3); // CompletionItemKind.Function

  });



  it("maps 'local function' → Function", () => {

    expect(tsKindToLSP("local function")).toBe(3);

  });



  it("maps 'method' → Method", () => {

    expect(tsKindToLSP("method")).toBe(2);

  });



  it("maps 'property' → Property", () => {

    expect(tsKindToLSP("property")).toBe(10);

  });



  it("maps 'accessor' → Property", () => {

    expect(tsKindToLSP("accessor")).toBe(10);

  });



  it("maps 'member' → Property", () => {

    expect(tsKindToLSP("member")).toBe(10);

  });



  it("maps 'class' → Class", () => {

    expect(tsKindToLSP("class")).toBe(7);

  });



  it("maps 'interface' → Interface", () => {

    expect(tsKindToLSP("interface")).toBe(8);

  });



  it("maps 'module' → Module", () => {

    expect(tsKindToLSP("module")).toBe(9);

  });



  it("maps 'variable' → Variable", () => {

    expect(tsKindToLSP("variable")).toBe(6);

  });



  it("maps 'local var' → Variable", () => {

    expect(tsKindToLSP("local var")).toBe(6);

  });



  it("maps 'const' → Constant", () => {

    expect(tsKindToLSP("const")).toBe(21);

  });



  it("maps 'keyword' → Keyword", () => {

    expect(tsKindToLSP("keyword")).toBe(14);

  });



  it("maps 'type' → TypeParameter", () => {

    expect(tsKindToLSP("type")).toBe(25);

  });



  it("maps unknown kind → Text", () => {

    expect(tsKindToLSP("enum")).toBe(1);

    expect(tsKindToLSP("")).toBe(1);

    expect(tsKindToLSP("unknown-kind")).toBe(1);

  });

});

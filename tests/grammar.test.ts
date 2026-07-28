import { beforeAll, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { createRequire } from "node:module";
import {
  INITIAL,
  Registry,
  parseRawGrammar,
  type IGrammar,
  type IRawGrammar,
  type StateStack,
} from "vscode-textmate";
import {
  loadWASM,
  OnigScanner,
  OnigString,
} from "vscode-oniguruma";

const javascriptGrammar: IRawGrammar = {
  scopeName: "source.js",
  repository: {} as IRawGrammar["repository"],
  patterns: [
    { name: "comment.line.double-slash.js", begin: "//", end: "$" },
    { name: "comment.block.js", begin: "/\\*", end: "\\*/" },
    { name: "string.quoted.double.js", begin: '"', end: '"' },
    { name: "string.quoted.single.js", begin: "'", end: "'" },
    {
      name: "keyword.control.js",
      match: "\\b(?:const|let|if|else|for|return|await)\\b",
    },
    { name: "constant.numeric.js", match: "\\b\\d+\\b" },
  ],
};

const htmlGrammar: IRawGrammar = {
  scopeName: "text.html.basic",
  repository: {} as IRawGrammar["repository"],
  patterns: [
    { name: "comment.block.html", begin: "<!--", end: "-->" },
    {
      name: "meta.tag.html",
      begin: "</?",
      end: ">",
      patterns: [
        {
          name: "entity.name.tag.html",
          match: "[A-Za-z][A-Za-z0-9-]*",
        },
        {
          name: "string.quoted.double.html",
          begin: '"',
          end: '"',
        },
        {
          name: "string.quoted.single.html",
          begin: "'",
          end: "'",
        },
      ],
    },
  ],
};

interface TokenView {
  text: string;
  scopes: string[];
}

let grammar: IGrammar;

beforeAll(async () => {
  const require = createRequire(import.meta.url);
  const wasmPath = require.resolve("vscode-oniguruma/release/onig.wasm");
  const wasm = fs.readFileSync(wasmPath);
  await loadWASM(
    wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength),
  );
  const injectionPath = path.resolve(
    "syntaxes",
    "eta-injection.tmLanguage.json",
  );

  const grammarPath = path.resolve("syntaxes", "eta.tmLanguage.json");
  const registry = new Registry({
    onigLib: Promise.resolve({
      createOnigScanner: (sources) => new OnigScanner(sources),
      createOnigString: (value) => new OnigString(value),
    }),
    getInjections: () => ["source.eta.injection"],
    loadGrammar: async (scopeName) => {
      if (scopeName === "source.eta") {
        return parseRawGrammar(fs.readFileSync(grammarPath, "utf8"), grammarPath);
      }
      if (scopeName === "source.eta.injection") {
        return parseRawGrammar(
          fs.readFileSync(injectionPath, "utf8"),
          injectionPath,
        );
      }
      if (scopeName === "source.js") return javascriptGrammar;
      if (scopeName === "text.html.basic") return htmlGrammar;
      return null;
    },
  });
  const loaded = await registry.loadGrammar("source.eta");
  if (!loaded) throw new Error("Eta TextMate grammar did not load");
  grammar = loaded;
});

function tokenize(source: string): TokenView[][] {
  let stack: StateStack = INITIAL;
  return source.split("\n").map((line) => {
    const result = grammar.tokenizeLine(line, stack);
    stack = result.ruleStack;
    return result.tokens.map((token) => ({
      text: line.slice(token.startIndex, token.endIndex),
      scopes: token.scopes,
    }));
  });
}

function tokenWithText(tokens: TokenView[], text: string): TokenView {
  const token = tokens.find((candidate) => candidate.text === text);
  if (!token) throw new Error(`No token for ${JSON.stringify(text)}`);
  return token;
}

describe("Eta TextMate grammar", () => {
  it("delegates HTML to the standard HTML grammar", () => {
    const [tokens] = tokenize('<section class="card">Hello</section>');

    expect(tokenWithText(tokens, "section").scopes).toContain(
      "entity.name.tag.html",
    );
    expect(tokenWithText(tokens, "card").scopes).toContain(
      "string.quoted.double.html",
    );
  });

  it("embeds JavaScript scopes inside Eta tags", () => {
    const [tokens] = tokenize('<% const total = 2 %><%= total %>');

    expect(tokenWithText(tokens, "const").scopes).toContain("keyword.control.js");
    expect(tokenWithText(tokens, "2").scopes).toContain("constant.numeric.js");
    expect(
      tokens.some((token) =>
        token.scopes.includes("punctuation.section.embedded.begin.eta"),
      ),
    ).toBe(true);
    expect(
      tokens.some((token) =>
        token.scopes.includes("punctuation.section.embedded.end.eta"),
      ),
    ).toBe(true);
  });

  it("continues embedded JavaScript across lines", () => {
    const lines = tokenize("<% if (it.ready) {\n  const value = 1\n} %>");

    expect(tokenWithText(lines[0], "if").scopes).toContain("keyword.control.js");
    expect(tokenWithText(lines[1], "const").scopes).toContain(
      "keyword.control.js",
    );
    expect(tokenWithText(lines[1], "1").scopes).toContain(
      "constant.numeric.js",
    );
  });

  it("keeps opaque custom tags out of JavaScript", () => {
    const [tokens] = tokenize("<%# const markdown = 1 %>");
    const content = tokens.find((token) => token.text.includes("const markdown"));

    expect(
      tokens.some((token) => token.scopes.includes("keyword.operator.custom.eta")),
    ).toBe(true);
    expect(content?.scopes).not.toContain("keyword.control.js");
  });

  it("tokenizes Eta tags inside HTML attributes", () => {
    const [tokens] = tokenize('<div title="<%= it.title %>">');

    expect(
      tokens.some((token) =>
        token.scopes.includes("punctuation.section.embedded.begin.eta"),
      ),
    ).toBe(true);
    expect(
      tokens.some((token) => token.scopes.includes("source.js")),
    ).toBe(true);
  });
});

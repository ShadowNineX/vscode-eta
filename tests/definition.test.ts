import { describe, expect, it } from "vitest";
import {
  getEtaDataPathAtPosition,
  offsetToPosition,
} from "../src/definition";
import {
  DEFAULT_ETA_LANGUAGE_OPTIONS,
  EtaLanguageOptions,
} from "../src/etaConfig";
import { buildVirtualContent } from "../src/virtualDocument";

function dataPathAt(
  expression: string,
  target: string,
  options: EtaLanguageOptions = DEFAULT_ETA_LANGUAGE_OPTIONS,
): string[] | undefined {
  const virtualContent = buildVirtualContent(
    `<%= ${expression} %>`,
    "{ user: { name: string }; items: Array<{ title: string }> }",
    options,
  );
  const offset = virtualContent.lastIndexOf(target);
  if (offset < 0) throw new Error(`Target ${target} was not found`);
  return getEtaDataPathAtPosition(virtualContent, offset + 1, options);
}

describe("getEtaDataPathAtPosition", () => {
  it("resolves each selected segment of a nested it access", () => {
    expect(dataPathAt("it.user.name", "user")).toEqual(["user"]);
    expect(dataPathAt("it.user.name", "name")).toEqual(["user", "name"]);
  });

  it("resolves string keys and skips numeric array indexes", () => {
    expect(dataPathAt('it["user"].name', "user")).toEqual(["user"]);
    expect(dataPathAt("it.items[0].title", "title")).toEqual([
      "items",
      "title",
    ]);
  });

  it("supports custom varName and useWith data access", () => {
    const customOptions = {
      ...DEFAULT_ETA_LANGUAGE_OPTIONS,
      varName: "data",
    };
    expect(dataPathAt("data.user.name", "name", customOptions)).toEqual([
      "user",
      "name",
    ]);

    const withOptions = {
      ...DEFAULT_ETA_LANGUAGE_OPTIONS,
      useWith: true,
    };
    expect(dataPathAt("user.name", "name", withOptions)).toEqual([
      "user",
      "name",
    ]);
  });

  it("does not treat local variables as render data", () => {
    expect(dataPathAt("localValue", "localValue")).toBeUndefined();
  });
});

describe("offsetToPosition", () => {
  it("maps source offsets to zero-based LSP positions", () => {
    expect(offsetToPosition("first\nsecond\n", 9)).toEqual({
      line: 1,
      character: 3,
    });
  });
});

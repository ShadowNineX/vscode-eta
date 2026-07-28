import { describe, expect, it } from "vitest";
import * as path from "node:path";
import { DEFAULT_ETA_LANGUAGE_OPTIONS } from "../src/etaConfig";
import {
  getBlockCallContexts,
  getTemplatePathCompletions,
  getTemplatePathContextAtOffset,
} from "../src/templateContext";

describe("Eta helper string contexts", () => {
  it("finds completed and in-progress include paths", () => {
    const completed = '<%~ include("./partials/card") %>';
    const completedOffset = completed.indexOf("card") + 2;
    expect(
      getTemplatePathContextAtOffset(
        completed,
        completedOffset,
        DEFAULT_ETA_LANGUAGE_OPTIONS,
      ),
    ).toMatchObject({ functionName: "include", value: "./partials/card" });

    const inProgress = '<% layout("./lay';
    expect(
      getTemplatePathContextAtOffset(
        inProgress,
        inProgress.length,
        DEFAULT_ETA_LANGUAGE_OPTIONS,
      ),
    ).toMatchObject({ functionName: "layout", value: "./lay" });
  });

  it("distinguishes block declarations from usages", () => {
    const source =
      '<% block("header", () => {}) %>\n<% block("header") %>';
    expect(getBlockCallContexts(source, DEFAULT_ETA_LANGUAGE_OPTIONS)).toEqual([
      expect.objectContaining({ value: "header", declaration: true }),
      expect.objectContaining({ value: "header", declaration: false }),
    ]);
  });

  it("returns sorted relative completion paths without extensions", () => {
    const current = path.join("workspace", "views", "page.eta");
    expect(
      getTemplatePathCompletions(current, "./partials/", [
        current,
        path.join("workspace", "views", "partials", "zeta.eta"),
        path.join("workspace", "views", "partials", "alpha.eta"),
      ]),
    ).toEqual(["./partials/alpha", "./partials/zeta"]);
  });
});

import { describe, expect, it, vi } from "vitest";
import type * as vscode from "vscode";
import {
  createExtensionLogger,
  createServerLogger,
} from "../src/logging";

describe("logging", () => {
  it("routes extension log levels with a scoped prefix", () => {
    const methods = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    };
    // The logger only consumes these four methods from LogOutputChannel.
    const output = methods as unknown as vscode.LogOutputChannel;
    const logger = createExtensionLogger(output, "provider");

    logger.info("ready");
    logger.warn("slow");
    logger.error("failed");
    logger.debug("details");

    expect(methods.info).toHaveBeenCalledWith("[eta:provider] ready");
    expect(methods.warn).toHaveBeenCalledWith("[eta:provider] slow");
    expect(methods.error).toHaveBeenCalledWith("[eta:provider] failed");
    expect(methods.debug).toHaveBeenCalledWith("[eta:provider] details");
  });

  it("maps server debug output to log and tolerates no console", () => {
    const output = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      log: vi.fn(),
    };
    const logger = createServerLogger(output, "server");

    logger.info("ready");
    logger.warn("slow");
    logger.error("failed");
    logger.debug("details");

    expect(output.info).toHaveBeenCalledWith("[eta:server] ready");
    expect(output.warn).toHaveBeenCalledWith("[eta:server] slow");
    expect(output.error).toHaveBeenCalledWith("[eta:server] failed");
    expect(output.log).toHaveBeenCalledWith("[eta:server] details");
    expect(() => createServerLogger(undefined, "server").debug("quiet")).not.toThrow();
  });
});

import type * as vscode from "vscode";

export type EtaLogLevel = "info" | "warn" | "error" | "debug";

export interface EtaLogger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
  debug(message: string): void;
}

interface ServerConsole {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
  log(message: string): void;
}

function format(scope: string, message: string): string {
  return `[eta:${scope}] ${message}`;
}

export function createExtensionLogger(
  output: vscode.LogOutputChannel,
  scope = "extension",
): EtaLogger {
  return {
    info: (message) => output.info(format(scope, message)),
    warn: (message) => output.warn(format(scope, message)),
    error: (message) => output.error(format(scope, message)),
    debug: (message) => output.debug(format(scope, message)),
  };
}

export function createServerLogger(
  output: ServerConsole | undefined,
  scope: string,
): EtaLogger {
  return {
    info: (message) => output?.info(format(scope, message)),
    warn: (message) => output?.warn(format(scope, message)),
    error: (message) => output?.error(format(scope, message)),
    debug: (message) => output?.log(format(scope, message)),
  };
}

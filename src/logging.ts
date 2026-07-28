import type * as vscode from "vscode";

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

function createLogger(
  scope: string,
  write: (level: keyof EtaLogger, message: string) => void,
): EtaLogger {
  return {
    info: (message) => write("info", format(scope, message)),
    warn: (message) => write("warn", format(scope, message)),
    error: (message) => write("error", format(scope, message)),
    debug: (message) => write("debug", format(scope, message)),
  };
}

export function createExtensionLogger(
  output: vscode.LogOutputChannel,
  scope = "extension",
): EtaLogger {
  return createLogger(scope, (level, message) => output[level](message));
}

export function createServerLogger(
  output: ServerConsole | undefined,
  scope: string,
): EtaLogger {
  return createLogger(scope, (level, message) => {
    if (level === "debug") {
      output?.log(message);
    } else {
      output?.[level](message);
    }
  });
}

import { EXIT_CODE } from "./constants.js";

export interface AnboErrorMetadata {
  phase?: string;
  retryable?: boolean;
  safe_to_retry?: boolean;
  evidence?: unknown;
}

export class AnboError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly exitCode: number = EXIT_CODE.operationFailed,
    readonly hint?: string,
    readonly metadata?: AnboErrorMetadata,
  ) {
    super(message);
    this.name = "AnboError";
  }
}

export class UsageError extends AnboError {
  constructor(message: string, hint?: string) {
    super(message, "ANBO_USAGE", EXIT_CODE.usage, hint);
  }
}

export class PluginUnavailableError extends AnboError {
  constructor(target: string, packageName: string) {
    super(
      `Plugin ${target} is not installed (${packageName}).`,
      "ANBO_PLUGIN_UNAVAILABLE",
      EXIT_CODE.pluginUnavailable,
      `Install ${packageName} in this project and run anbo configure --target ${target}.`,
    );
  }
}

export class PluginCompatibilityError extends AnboError {
  constructor(message: string) {
    super(message, "ANBO_PLUGIN_INCOMPATIBLE", EXIT_CODE.pluginIncompatible);
  }
}

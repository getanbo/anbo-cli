import type { PluginContextV1 } from "@getanbo/plugin-sdk";

import type {
  CommandExecutor,
  RuntimeCommandOptions,
  RuntimeCommandResult,
} from "./runtime/ministack.js";

/** Routes every managed child process through the canonical CLI host. */
export class HostCommandExecutor implements CommandExecutor {
  constructor(private readonly context: PluginContextV1) {}

  async run(
    command: string,
    args: readonly string[],
    options: RuntimeCommandOptions = {},
  ): Promise<RuntimeCommandResult> {
    if (options.signal?.aborted === true) {
      throw options.signal.reason instanceof Error
        ? options.signal.reason
        : new DOMException("The operation was aborted", "AbortError");
    }
    const result = await this.context.process.run(command, args, {
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      ...(options.env === undefined ? {} : { env: options.env }),
      ...(options.input === undefined ? {} : {
        input: typeof options.input === "string" ? options.input : Buffer.from(options.input).toString("utf8"),
      }),
      allow_failure: true,
    });
    if (result.stdout.length > 0) await options.onOutput?.("stdout", result.stdout);
    if (result.stderr.length > 0) await options.onOutput?.("stderr", result.stderr);
    return { code: result.exit_code, stdout: result.stdout, stderr: result.stderr };
  }
}

export function hostFetch(context: PluginContextV1): typeof globalThis.fetch {
  return ((input: string | URL | Request, init?: RequestInit) => {
    if (input instanceof Request) return context.http.request(input.url, { ...init, method: init?.method ?? input.method });
    return context.http.request(input, init);
  }) as typeof globalThis.fetch;
}

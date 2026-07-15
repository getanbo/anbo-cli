import { spawn } from "node:child_process";
import { performance } from "node:perf_hooks";
import type { ProcessRunOptionsV1, ProcessRunResultV1 } from "@getanbo/plugin-sdk";
import { AnboError } from "./errors.js";

const MAX_CAPTURE_BYTES = 8 * 1024 * 1024;

export async function runProcess(
  command: string,
  args: readonly string[],
  options: ProcessRunOptionsV1 = {},
  signal?: AbortSignal,
): Promise<ProcessRunResultV1> {
  if (!command || command.includes("\0")) throw new AnboError("Invalid process command.", "ANBO_PROCESS");
  const started = performance.now();
  const env = Object.fromEntries(
    Object.entries({ ...process.env, ...options.env }).filter((entry): entry is [string, string] => {
      return typeof entry[1] === "string";
    }),
  );

  return await new Promise((resolve, reject) => {
    const child = spawn(command, [...args], {
      cwd: options.cwd,
      env,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout = appendBounded(stdout, chunk);
    });
    child.stderr.on("data", (chunk: string) => {
      stderr = appendBounded(stderr, chunk);
    });
    if (options.input !== undefined) child.stdin.end(options.input);
    else child.stdin.end();

    const abort = () => child.kill("SIGTERM");
    signal?.addEventListener("abort", abort, { once: true });
    const timeout = options.timeout_ms
      ? setTimeout(() => child.kill("SIGTERM"), options.timeout_ms)
      : undefined;

    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new AnboError(`Could not run ${command}: ${error.message}`, "ANBO_PROCESS"));
    });
    child.once("close", (exitCode, terminationSignal) => {
      if (settled) return;
      settled = true;
      cleanup();
      const result: ProcessRunResultV1 = {
        command,
        args,
        exit_code: exitCode ?? (terminationSignal ? 128 : 1),
        stdout,
        stderr,
        duration_ms: Math.round(performance.now() - started),
      };
      if (result.exit_code !== 0 && !options.allow_failure) {
        reject(
          new AnboError(
            `${command} exited with code ${result.exit_code}${stderr ? `: ${stderr.trim()}` : ""}`,
            "ANBO_PROCESS_FAILED",
          ),
        );
      } else {
        resolve(result);
      }
    });

    function cleanup(): void {
      signal?.removeEventListener("abort", abort);
      if (timeout) clearTimeout(timeout);
    }
  });
}

function appendBounded(current: string, chunk: string): string {
  if (current.length >= MAX_CAPTURE_BYTES) return current;
  return `${current}${chunk}`.slice(0, MAX_CAPTURE_BYTES);
}

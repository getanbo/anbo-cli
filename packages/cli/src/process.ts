import { spawn } from "node:child_process";
import { performance } from "node:perf_hooks";
import type { ProcessRunOptionsV1, ProcessRunResultV1 } from "@getanbo/plugin-sdk";
import { AnboError } from "./errors.js";

const MAX_CAPTURE_BYTES = 8 * 1024 * 1024;
const TERMINATION_GRACE_MS = 250;

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
  const activeSignal = signal === undefined
    ? options.signal
    : options.signal === undefined
      ? signal
      : AbortSignal.any([signal, options.signal]);
  if (activeSignal?.aborted === true) {
    throw activeSignal.reason instanceof Error
      ? activeSignal.reason
      : new DOMException("The operation was aborted", "AbortError");
  }

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
    let outputChain = Promise.resolve();
    let outputError: unknown;
    let terminationRequested = false;
    let forceKill: NodeJS.Timeout | undefined;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout = appendBounded(stdout, chunk);
      queueOutput("stdout", chunk);
    });
    child.stderr.on("data", (chunk: string) => {
      stderr = appendBounded(stderr, chunk);
      queueOutput("stderr", chunk);
    });
    if (options.input !== undefined) child.stdin.end(options.input);
    else child.stdin.end();

    const abort = () => requestTermination();
    activeSignal?.addEventListener("abort", abort, { once: true });
    if (activeSignal?.aborted === true) abort();
    const timeout = options.timeout_ms
      ? setTimeout(requestTermination, options.timeout_ms)
      : undefined;

    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new AnboError(`Could not run ${command}: ${error.message}`, "ANBO_PROCESS"));
    });
    child.once("close", (exitCode, terminationSignal) => {
      if (settled) return;
      void outputChain.then(() => {
        if (settled) return;
        settled = true;
        cleanup();
        if (outputError !== undefined) {
          reject(outputError);
          return;
        }
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
    });

    function queueOutput(stream: "stdout" | "stderr", chunk: string): void {
      if (options.on_output === undefined) return;
      outputChain = outputChain.then(async () => options.on_output?.(stream, chunk)).catch((error: unknown) => {
        outputError ??= error;
        requestTermination();
      });
    }

    function requestTermination(): void {
      if (settled || terminationRequested) return;
      terminationRequested = true;
      child.kill("SIGTERM");
      forceKill = setTimeout(() => {
        if (!settled) child.kill("SIGKILL");
      }, TERMINATION_GRACE_MS);
    }

    function cleanup(): void {
      activeSignal?.removeEventListener("abort", abort);
      if (timeout) clearTimeout(timeout);
      if (forceKill) clearTimeout(forceKill);
    }
  });
}

function appendBounded(current: string, chunk: string): string {
  if (current.length >= MAX_CAPTURE_BYTES) return current;
  return `${current}${chunk}`.slice(0, MAX_CAPTURE_BYTES);
}

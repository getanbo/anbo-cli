import { spawn, type ChildProcess } from "node:child_process";
import { basename } from "node:path";

import type { PluginEventSink } from "./event-sink.js";

export interface ProcessChunk {
  stream: "stdout" | "stderr";
  chunk: string;
  pid: number;
  timestamp: string;
}

export interface SpawnStreamingOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  inheritEnv?: boolean;
  input?: string | Buffer;
  signal?: AbortSignal;
  timeoutMs?: number;
  cancelGraceMs?: number;
  captureOutput?: boolean;
  maxCaptureBytes?: number;
  maxChunkBytes?: number;
  rejectOnNonZero?: boolean;
  killProcessGroup?: boolean;
  eventSink?: Pick<PluginEventSink, "emit" | "processOutput">;
  phase?: string;
  source?: string;
  service?: string;
  commandLabel?: string;
  onOutput?: (output: ProcessChunk) => void | Promise<void>;
  onSpawn?: (child: ChildProcess) => void;
}

export interface ProcessResult {
  command: string;
  pid: number;
  code: number | null;
  signal: NodeJS.Signals | null;
  durationMs: number;
  cancelled: boolean;
  timedOut: boolean;
  stdout?: string;
  stderr?: string;
  stdoutTruncated?: boolean;
  stderrTruncated?: boolean;
}

export class ProcessExecutionError extends Error {
  constructor(
    message: string,
    readonly result: ProcessResult,
  ) {
    super(message);
    this.name = "ProcessExecutionError";
  }
}

function appendBounded(
  current: string,
  chunk: string,
  maxBytes: number,
): { value: string; truncated: boolean } {
  const used = Buffer.byteLength(current);
  if (used >= maxBytes) return { value: current, truncated: true };
  const available = maxBytes - used;
  if (Buffer.byteLength(chunk) <= available) return { value: current + chunk, truncated: false };
  let end = Math.min(chunk.length, available);
  while (end > 0 && Buffer.byteLength(chunk.slice(0, end)) > available) end -= 1;
  return { value: current + chunk.slice(0, end), truncated: true };
}

function splitChunk(chunk: string, maxBytes: number): string[] {
  if (Buffer.byteLength(chunk) <= maxBytes) return [chunk];
  const parts: string[] = [];
  let remaining = chunk;
  while (remaining.length > 0) {
    let end = Math.min(remaining.length, maxBytes);
    while (end > 1 && Buffer.byteLength(remaining.slice(0, end)) > maxBytes) end -= 1;
    parts.push(remaining.slice(0, end));
    remaining = remaining.slice(end);
  }
  return parts;
}

function terminate(child: ChildProcess, signal: NodeJS.Signals, processGroup: boolean): void {
  if (!child.pid) return;
  try {
    if (processGroup && process.platform !== "win32") {
      process.kill(-child.pid, signal);
    } else {
      child.kill(signal);
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ESRCH") throw error;
  }
}

/** Spawn a command without blocking while preserving and streaming both output channels. */
export async function spawnStreaming(
  command: string,
  args: readonly string[] = [],
  options: SpawnStreamingOptions = {},
): Promise<ProcessResult> {
  if (options.signal?.aborted) {
    throw options.signal.reason instanceof Error
      ? options.signal.reason
      : new DOMException("The operation was aborted", "AbortError");
  }

  const started = Date.now();
  const maxCaptureBytes = Math.max(0, options.maxCaptureBytes ?? 1024 * 1024);
  const maxChunkBytes = Math.max(256, options.maxChunkBytes ?? 16 * 1024);
  const captureOutput = options.captureOutput ?? false;
  const processGroup = (options.killProcessGroup ?? true) && process.platform !== "win32";
  const environment = options.inheritEnv === false ? (options.env ?? {}) : { ...process.env, ...options.env };
  const child = spawn(command, [...args], {
    cwd: options.cwd,
    env: environment,
    detached: processGroup,
    stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
  });
  const pid = child.pid ?? -1;
  const source = options.source ?? basename(command);
  const phase = options.phase ?? "process";
  const label = options.commandLabel ?? basename(command);
  options.onSpawn?.(child);
  const completion = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve, reject) => {
      child.once("error", reject);
      child.once("close", (exitCode, exitSignal) => resolve({ code: exitCode, signal: exitSignal }));
    },
  );

  let cancelled = false;
  let timedOut = false;
  let stdout = "";
  let stderr = "";
  let stdoutTruncated = false;
  let stderrTruncated = false;
  let outputError: unknown;
  let outputChain: Promise<void> = Promise.resolve();

  const queueOutput = (stream: "stdout" | "stderr", raw: Buffer | string): void => {
    for (const chunk of splitChunk(raw.toString(), maxChunkBytes)) {
      const output: ProcessChunk = {
        stream,
        chunk,
        pid,
        timestamp: new Date().toISOString(),
      };
      outputChain = outputChain
        .then(async () => {
          if (captureOutput) {
            if (stream === "stdout") {
              const appended = appendBounded(stdout, chunk, maxCaptureBytes);
              stdout = appended.value;
              stdoutTruncated ||= appended.truncated;
            } else {
              const appended = appendBounded(stderr, chunk, maxCaptureBytes);
              stderr = appended.value;
              stderrTruncated ||= appended.truncated;
            }
          }
          await options.eventSink?.processOutput({
            phase,
            source,
            ...(options.service === undefined ? {} : { service: options.service }),
            stream,
            chunk,
            pid,
          });
          await options.onOutput?.(output);
        })
        .catch((error) => {
          outputError ??= error;
          terminate(child, "SIGTERM", processGroup);
        });
    }
  };

  child.stdout?.on("data", (chunk: Buffer) => queueOutput("stdout", chunk));
  child.stderr?.on("data", (chunk: Buffer) => queueOutput("stderr", chunk));

  await options.eventSink?.emit({
    kind: "progress",
    phase,
    source,
    ...(options.service === undefined ? {} : { service: options.service }),
    level: "info",
    message: `${label} started`,
    fields: { status: "started", pid },
  });

  let forceKillTimer: NodeJS.Timeout | undefined;
  const cancel = (timeout: boolean): void => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    cancelled = true;
    timedOut ||= timeout;
    terminate(child, "SIGTERM", processGroup);
    forceKillTimer = setTimeout(
      () => terminate(child, "SIGKILL", processGroup),
      Math.max(0, options.cancelGraceMs ?? 5_000),
    );
    forceKillTimer.unref();
  };
  const abortListener = () => cancel(false);
  options.signal?.addEventListener("abort", abortListener, { once: true });
  const timeoutTimer = options.timeoutMs
    ? setTimeout(() => cancel(true), Math.max(1, options.timeoutMs))
    : undefined;
  timeoutTimer?.unref();

  if (options.input !== undefined) {
    child.stdin?.end(options.input);
  }

  let code: number | null;
  let signal: NodeJS.Signals | null;
  try {
    ({ code, signal } = await completion);
    await outputChain;
    if (outputError) throw outputError;
  } finally {
    options.signal?.removeEventListener("abort", abortListener);
    if (timeoutTimer) clearTimeout(timeoutTimer);
    if (forceKillTimer) clearTimeout(forceKillTimer);
  }

  const result: ProcessResult = {
    command: label,
    pid,
    code,
    signal,
    durationMs: Date.now() - started,
    cancelled,
    timedOut,
    ...(captureOutput
      ? { stdout, stderr, stdoutTruncated, stderrTruncated }
      : {}),
  };
  await options.eventSink?.emit({
    kind: "progress",
    phase,
    source,
    ...(options.service === undefined ? {} : { service: options.service }),
    level: code === 0 && !cancelled ? "info" : "error",
    message: `${label} ${cancelled ? (timedOut ? "timed out" : "cancelled") : `exited with code ${String(code)}`}`,
    fields: { status: cancelled ? "cancelled" : code === 0 ? "succeeded" : "failed", ...result },
  });

  if (options.rejectOnNonZero && (code !== 0 || cancelled)) {
    throw new ProcessExecutionError(`${label} did not complete successfully`, result);
  }
  return result;
}

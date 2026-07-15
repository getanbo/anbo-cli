import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { constants } from "node:fs";
import type { AnboEvent } from "@getanbo/plugin-sdk";

export interface CliRunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  events: AnboEvent[];
}

export async function runInstalledAnbo(
  installRoot: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<CliRunResult> {
  const binary = `${installRoot}/node_modules/.bin/anbo`;
  await access(binary, constants.X_OK);

  return await new Promise((resolve, reject) => {
    const child = spawn(binary, args, {
      cwd: options.cwd ?? installRoot,
      env: { ...process.env, ...options.env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => (stdout += chunk));
    child.stderr.on("data", (chunk: string) => (stderr += chunk));
    child.once("error", reject);
    child.once("close", (exitCode) => {
      const events = parseJsonLines(stdout);
      resolve({ exitCode: exitCode ?? 1, stdout, stderr, events });
    });
  });
}

export function parseJsonLines(output: string): AnboEvent[] {
  const lines = output.split(/\r?\n/u).filter(Boolean);
  return lines.map((line, index) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      throw new Error(`line ${index + 1} is not JSON: ${String(error)}`);
    }
    if (!isRecord(parsed)) {
      throw new Error(`line ${index + 1} is not a JSON object`);
    }
    return parsed as unknown as AnboEvent;
  });
}

export function assertEventStream(events: AnboEvent[]): void {
  if (events.length < 2) {
    throw new Error("expected at least run.started and run.finished events");
  }
  const runId = events[0]?.runId;
  events.forEach((event, index) => {
    if (event.apiVersion !== "anbo.dev/event/v1") {
      throw new Error(`event ${index + 1} has an unsupported apiVersion`);
    }
    if (event.runId !== runId) {
      throw new Error(`event ${index + 1} changed runId`);
    }
    if (event.sequence !== index + 1) {
      throw new Error(`event ${index + 1} has a non-contiguous sequence`);
    }
  });
  if (events[0]?.type !== "run.started") {
    throw new Error("event stream must start with run.started");
  }
  if (events.at(-1)?.type !== "run.finished") {
    throw new Error("event stream must end with run.finished");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

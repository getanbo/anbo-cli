import { randomUUID } from "node:crypto";

import type { PluginContextV1, PluginEventV1 } from "@getanbo/plugin-sdk";

import { Redactor } from "./redaction.js";
import type { JsonlV1TestEvent } from "./runtime/test-events.js";
import type { RunEventInput } from "./types.js";

type EventInput = Omit<RunEventInput, "redacted"> & { redacted?: boolean };

export interface DiagnosticEvent {
  code: string;
  cause: string;
  evidence?: unknown;
  remediation: string;
  retryable: boolean;
  safe_to_retry: boolean;
  phase?: string;
  source?: string;
  level?: "debug" | "info" | "warn" | "error";
}

export interface TestAssertionEvent {
  name: string;
  passed: boolean;
  expected?: unknown;
  actual?: unknown;
  duration_ms?: number;
}

export class PluginPhase {
  private completed = false;

  constructor(
    private readonly sink: PluginEventSink,
    readonly id: string,
    readonly name: string,
    readonly source: string,
  ) {}

  progress(message: string, fields?: Record<string, unknown>): Promise<void> {
    return this.sink.emit({
      kind: "progress",
      phase: this.id,
      source: this.source,
      level: "info",
      message,
      fields: { phase_name: this.name, ...fields },
      redacted: true,
    });
  }

  async finish(message = `${this.name} completed`, fields?: Record<string, unknown>): Promise<void> {
    if (this.completed) throw new Error(`Phase ${this.id} is already complete`);
    this.completed = true;
    await this.sink.emit({
      kind: "progress",
      phase: this.id,
      source: this.source,
      level: "info",
      message,
      fields: { phase_name: this.name, status: "succeeded", ...fields },
      redacted: true,
    });
  }

  async fail(message: string, fields?: Record<string, unknown>): Promise<void> {
    if (this.completed) throw new Error(`Phase ${this.id} is already complete`);
    this.completed = true;
    await this.sink.emit({
      kind: "progress",
      phase: this.id,
      source: this.source,
      level: "error",
      message,
      fields: { phase_name: this.name, status: "failed", ...fields },
      redacted: true,
    });
  }
}

/** Bridges MiniStack runtime events into the host. It never writes to a terminal. */
export class PluginEventSink {
  readonly redactor = new Redactor();

  constructor(
    private readonly context: PluginContextV1,
    readonly runId: string = `plugin_${randomUUID()}`,
  ) {}

  async emit(input: EventInput): Promise<void> {
    const redacted = this.redactor.redact({
      kind: input.kind,
      phase: input.phase,
      source: input.source,
      level: input.level,
      message: input.message,
      ...(input.service === undefined ? {} : { service: input.service }),
      ...(input.test_id === undefined ? {} : { test_id: input.test_id }),
      ...(input.correlation_id === undefined ? {} : { correlation_id: input.correlation_id }),
      ...(input.fields === undefined ? {} : { fields: input.fields }),
    }) as PluginEventV1;
    await this.context.events.emit(redacted);
  }

  async startPhase(name: string, source: string): Promise<PluginPhase> {
    const id = `${source}.${name}`.toLowerCase().replace(/[^a-z0-9_.-]+/g, "-");
    await this.emit({
      kind: "phase.started",
      phase: id,
      source,
      level: "info",
      message: name,
      fields: { phase_name: name },
      redacted: true,
    });
    return new PluginPhase(this, id, name, source);
  }

  processOutput(input: {
    phase: string;
    source: string;
    service?: string;
    stream: "stdout" | "stderr";
    chunk: string;
    pid?: number;
  }): Promise<void> {
    return this.emit({
      kind: "process.output",
      phase: input.phase,
      source: input.source,
      level: input.stream === "stderr" ? "warn" : "info",
      message: `${input.source} ${input.stream}`,
      ...(input.service === undefined ? {} : { service: input.service }),
      fields: { stream: input.stream, chunk: input.chunk, ...(input.pid === undefined ? {} : { pid: input.pid }) },
      redacted: false,
    });
  }

  diagnostic(input: DiagnosticEvent): Promise<void> {
    return this.emit({
      kind: "diagnostic",
      phase: input.phase ?? "runtime",
      source: input.source ?? "anbo.ministack",
      level: input.level ?? "error",
      message: input.cause,
      fields: {
        code: input.code,
        evidence: input.evidence,
        remediation: input.remediation,
        retryable: input.retryable,
        safe_to_retry: input.safe_to_retry,
      },
      redacted: false,
    });
  }

  assertion(input: TestAssertionEvent, options: { testId: string }): Promise<void> {
    return this.emit({
      kind: "test.assertion",
      phase: "test",
      source: "smoke",
      level: input.passed ? "info" : "error",
      message: `${input.name} ${input.passed ? "passed" : "failed"}`,
      test_id: options.testId,
      fields: { ...input },
      redacted: false,
    });
  }

  testProtocolEvent(testId: string, event: JsonlV1TestEvent): Promise<void> {
    const kind = event.kind === "test.assertion" ? "test.assertion" : event.kind;
    return this.emit({
      kind,
      phase: "test",
      source: "smoke",
      level: event.kind === "test.assertion" && event["passed"] === false ? "error" : "info",
      message: event.message ?? `${testId} ${event.kind}`,
      test_id: testId,
      fields: { ...event },
      redacted: false,
    });
  }

  startHeartbeat(options: { phase: string; source: string; intervalMs: number }): () => void {
    const timer = setInterval(() => {
      void this.emit({
        kind: "heartbeat",
        phase: options.phase,
        source: options.source,
        level: "debug",
        message: "operation is active",
        redacted: true,
      });
    }, options.intervalMs);
    timer.unref();
    return () => clearInterval(timer);
  }
}

import type {
  AnboEvent,
  EventLevel,
  JsonObject,
  OutputMode,
  PluginEventV1,
} from "@getanbo/plugin-sdk";
import { ANBO_EVENT_API_VERSION } from "@getanbo/plugin-sdk";
import { redactObject, redactText } from "./redaction.js";

export interface EventInput {
  type: string;
  level?: EventLevel;
  message?: string;
  data?: JsonObject;
  source?: string;
}

export class EventWriter {
  readonly events: AnboEvent[] = [];
  private sequence = 0;
  private finished = false;

  constructor(
    readonly runId: string,
    readonly command: string,
    private target: string | undefined,
    readonly output: OutputMode,
    private readonly writeOut: (value: string) => void,
    private readonly secretValues: string[] = [],
  ) {}

  addSecret(value: string): void {
    if (value.length >= 4 && !this.secretValues.includes(value)) this.secretValues.push(value);
  }

  setTarget(target: string): void {
    this.target ??= target;
  }

  emit(input: EventInput): AnboEvent {
    if (this.finished) throw new Error("cannot emit after run.finished");
    const event: AnboEvent = {
      apiVersion: ANBO_EVENT_API_VERSION,
      runId: this.runId,
      sequence: ++this.sequence,
      timestamp: new Date().toISOString(),
      source: input.source ?? "core",
      command: this.command,
      ...(this.target ? { target: this.target } : {}),
      type: input.type,
      level: input.level ?? "info",
      ...(input.message ? { message: redactText(input.message, this.secretValues) } : {}),
      ...(input.data ? { data: redactObject(input.data, this.secretValues) } : {}),
    };
    this.events.push(event);
    if (event.type === "run.finished") this.finished = true;
    if (this.output === "jsonl") this.writeOut(`${JSON.stringify(event)}\n`);
    if (this.output === "human") this.writeHuman(event);
    return event;
  }

  emitPlugin(event: PluginEventV1): void {
    const data: JsonObject = {
      ...(event.phase ? { phase: event.phase } : {}),
      ...(event.service ? { service: event.service } : {}),
      ...(event.test_id ? { test_id: event.test_id } : {}),
      ...(event.correlation_id ? { correlation_id: event.correlation_id } : {}),
      ...(event.fields ? { fields: toJsonObject(event.fields) } : {}),
      ...(event.data ? toJsonObject(event.data) : {}),
    };
    this.emit({
      type: event.kind ?? event.type ?? "plugin.event",
      level: event.level ?? "info",
      ...(event.message ? { message: event.message } : {}),
      data,
      source: event.source ?? "plugin",
    });
  }

  flushJson(exitCode: number): void {
    if (this.output !== "json") return;
    this.writeOut(
      `${JSON.stringify({
        apiVersion: "anbo.dev/run/v1",
        runId: this.runId,
        command: this.command,
        ...(this.target ? { target: this.target } : {}),
        exitCode,
        events: this.events,
      })}\n`,
    );
  }

  private writeHuman(event: AnboEvent): void {
    if (event.type === "run.started") return;
    if (event.type === "run.finished") {
      const status = event.data?.status === "succeeded" ? "completed" : event.data?.status;
      this.writeOut(`${status === "completed" ? "OK" : "ERROR"} ${this.command} ${status ?? "finished"}\n`);
      return;
    }
    if (!event.message) return;
    if (event.type === "help" || event.type === "version" || event.type === "plugin.list") {
      this.writeOut(`${event.message}\n`);
      return;
    }
    const prefix = event.level === "error" ? "ERROR" : event.level === "warn" ? "WARN" : "INFO";
    this.writeOut(`${prefix} ${event.message}\n`);
    if (event.data?.remediation && typeof event.data.remediation === "string") {
      this.writeOut(`     ${event.data.remediation}\n`);
    }
  }
}

function toJsonObject(value: Record<string, unknown>): JsonObject {
  return JSON.parse(JSON.stringify(value)) as JsonObject;
}

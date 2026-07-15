export const JSONL_V1_TEST_EVENT_KINDS = [
  "test.started",
  "test.progress",
  "test.assertion",
  "test.finished",
] as const;

export type JsonlV1TestEventKind = (typeof JSONL_V1_TEST_EVENT_KINDS)[number];

export interface JsonlV1TestEvent {
  schema_version: 1;
  kind: JsonlV1TestEventKind;
  name?: string;
  run_id?: string;
  correlation_id?: string;
  message?: string;
  status?: string;
  [key: string]: unknown;
}

export interface JsonlV1ProtocolIssue {
  line: number;
  reason: string;
}

export interface JsonlV1DecodeResult {
  events: JsonlV1TestEvent[];
  issues: JsonlV1ProtocolIssue[];
}

const DEFAULT_MAX_BUFFER_BYTES = 256 * 1024;

/** Incrementally decodes a declared JSONL test protocol without consuming raw output. */
export class JsonlV1TestEventDecoder {
  private buffer = "";
  private line = 0;

  constructor(private readonly maxBufferBytes = DEFAULT_MAX_BUFFER_BYTES) {}

  push(chunk: string): JsonlV1DecodeResult {
    this.buffer += chunk;
    const result: JsonlV1DecodeResult = { events: [], issues: [] };
    let newline = this.buffer.indexOf("\n");
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline).replace(/\r$/, "");
      this.buffer = this.buffer.slice(newline + 1);
      this.decodeLine(line, result);
      newline = this.buffer.indexOf("\n");
    }
    if (Buffer.byteLength(this.buffer) > this.maxBufferBytes) {
      this.line += 1;
      result.issues.push({ line: this.line, reason: `line exceeds ${this.maxBufferBytes} byte protocol limit` });
      this.buffer = "";
    }
    return result;
  }

  finish(): JsonlV1DecodeResult {
    const result: JsonlV1DecodeResult = { events: [], issues: [] };
    if (this.buffer.length > 0) this.decodeLine(this.buffer.replace(/\r$/, ""), result);
    this.buffer = "";
    return result;
  }

  private decodeLine(line: string, result: JsonlV1DecodeResult): void {
    this.line += 1;
    if (line.trim().length === 0) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      result.issues.push({ line: this.line, reason: "line is not valid JSON" });
      return;
    }
    const validation = validateJsonlV1TestEvent(parsed);
    if (typeof validation === "string") {
      result.issues.push({ line: this.line, reason: validation });
      return;
    }
    result.events.push(validation);
  }
}

export function validateJsonlV1TestEvent(value: unknown): JsonlV1TestEvent | string {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return "event must be a JSON object";
  const event = value as Record<string, unknown>;
  if (event["schema_version"] !== 1) return "schema_version must equal 1";
  if (typeof event["kind"] !== "string" || !JSONL_V1_TEST_EVENT_KINDS.includes(event["kind"] as JsonlV1TestEventKind)) {
    return `kind must be one of ${JSONL_V1_TEST_EVENT_KINDS.join(", ")}`;
  }
  for (const field of ["name", "run_id", "correlation_id", "message", "status"] as const) {
    if (event[field] !== undefined && typeof event[field] !== "string") return `${field} must be a string when present`;
  }
  if (typeof event["name"] === "string" && event["name"].length === 0) return "name must not be empty";
  return event as unknown as JsonlV1TestEvent;
}

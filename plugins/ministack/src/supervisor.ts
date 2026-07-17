import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import {
  access,
  chmod,
  mkdir,
  open,
  readFile,
  rename,
  stat,
  unlink,
  writeFile,
  type FileHandle,
} from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { REDACTED, Redactor } from "./redaction.js";

const STATE_SCHEMA_VERSION = 1 as const;
const LOCK_SCHEMA_VERSION = 2 as const;
const CURRENT_PROCESS_START_TIME = `node:${Math.floor((Date.now() - process.uptime() * 1_000) / 1_000)}`;
const OBSERVATIONAL_OPERATION_KINDS = new Set(["status", "logs", "debug", "capabilities", "impact"]);
const SECRET_KEY = /(?:^|[_-])(?:authorization|cookie|credentials?|database_url|dsn|password|passwd|private_key|secret(?:_access_key)?|session_token|token)$/i;
const SECRET_VALUES = [
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/i,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?):\/\/[^\s/@:]+:[^\s/@]+@/i,
];
const AWS_RESOURCE_ARN = /^arn:(?:aws|aws-cn|aws-us-gov):[a-z0-9-]+:[a-z0-9-]*:\d{0,12}:.+$/i;

export interface LockMetadata {
  schema_version: 1 | 2;
  operation_id: string;
  kind: string;
  pid: number;
  project_root: string;
  created_at: string;
  heartbeat_at: string;
  process_start_time?: string;
  lease_expires_at?: string;
}

interface ProcessInspection {
  alive: boolean;
  zombie: boolean;
  processStartTime?: string;
}

type ProcessInspector = (pid: number) => Promise<ProcessInspection>;

export interface FileOperationLockOptions {
  operationId: string;
  kind: string;
  projectRoot: string;
  staleLockMs?: number;
  heartbeatMs?: number;
  /** Test seam for deterministic dead, zombie, and PID-reuse coverage. */
  inspectProcess?: ProcessInspector;
}

export class OperationLockedError extends Error {
  constructor(
    readonly lockPath: string,
    readonly owner?: LockMetadata,
  ) {
    super(
      owner
        ? `Project is locked by ${owner.kind} operation ${owner.operation_id} (pid ${owner.pid})`
        : "Project is locked by another operation",
    );
    this.name = "OperationLockedError";
  }
}

function processExists(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function inspectWithPs(pid: number): Promise<ProcessInspection | undefined> {
  if (process.platform === "win32") return undefined;
  try {
    const stdout = await new Promise<string>((resolveOutput, rejectOutput) => {
      execFile(
        "/bin/ps",
        ["-o", "stat=", "-o", "lstart=", "-p", String(pid)],
        { encoding: "utf8", maxBuffer: 16 * 1024 },
        (error, output) => {
          if (error) rejectOutput(error);
          else resolveOutput(output);
        },
      );
    });
    const match = /^\s*(\S+)\s+(.+?)\s*$/.exec(stdout);
    if (match === null) return { alive: false, zombie: false };
    return {
      alive: true,
      zombie: match[1]!.includes("Z"),
      processStartTime: `ps:${match[2]!.replace(/\s+/g, " ")}`,
    };
  } catch {
    return undefined;
  }
}

async function inspectProcess(pid: number): Promise<ProcessInspection> {
  if (!processExists(pid)) return { alive: false, zombie: false };

  if (process.platform === "linux") {
    try {
      const value = await readFile(`/proc/${pid}/stat`, "utf8");
      const fields = value.slice(value.lastIndexOf(")") + 1).trim().split(/\s+/);
      const state = fields[0];
      const startTime = fields[19];
      if (state !== undefined && startTime !== undefined) {
        return {
          alive: true,
          zombie: state === "Z",
          processStartTime: `proc:${startTime}`,
        };
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { alive: false, zombie: false };
    }
  }

  const inspected = await inspectWithPs(pid);
  if (inspected !== undefined) return inspected;
  return {
    alive: processExists(pid),
    zombie: false,
    ...(pid === process.pid ? { processStartTime: CURRENT_PROCESS_START_TIME } : {}),
  };
}

function parseLock(value: string): LockMetadata | undefined {
  try {
    const parsed = JSON.parse(value) as Partial<LockMetadata>;
    if (
      (parsed.schema_version === 1 || parsed.schema_version === 2) &&
      typeof parsed.operation_id === "string" &&
      typeof parsed.kind === "string" &&
      typeof parsed.pid === "number" &&
      typeof parsed.project_root === "string" &&
      typeof parsed.created_at === "string" &&
      typeof parsed.heartbeat_at === "string" &&
      (parsed.process_start_time === undefined || typeof parsed.process_start_time === "string") &&
      (parsed.lease_expires_at === undefined || typeof parsed.lease_expires_at === "string")
    ) {
      return parsed as LockMetadata;
    }
  } catch {
    // A partial lock is recoverable once its filesystem timestamp is stale.
  }
  return undefined;
}

async function writeHandle(handle: FileHandle, value: string): Promise<void> {
  const data = Buffer.from(value);
  await handle.write(data, 0, data.length, 0);
  await handle.truncate(data.length);
  await handle.sync();
}

function lockLeaseExpired(owner: LockMetadata | undefined, mtimeMs: number, staleLockMs: number): boolean {
  const explicitExpiry = owner?.lease_expires_at === undefined
    ? Number.NaN
    : Date.parse(owner.lease_expires_at);
  if (Number.isFinite(explicitExpiry)) return Date.now() >= explicitExpiry;
  const heartbeat = owner === undefined ? Number.NaN : Date.parse(owner.heartbeat_at);
  const refreshedAt = Number.isFinite(heartbeat) ? Math.max(heartbeat, mtimeMs) : mtimeMs;
  return Date.now() - refreshedAt >= staleLockMs;
}

async function lockIsStale(
  owner: LockMetadata | undefined,
  mtimeMs: number,
  staleLockMs: number,
  processInspector: ProcessInspector,
): Promise<boolean> {
  const leaseExpired = lockLeaseExpired(owner, mtimeMs, staleLockMs);
  if (owner === undefined) return leaseExpired;

  const processState = await processInspector(owner.pid);
  if (!processState.alive || processState.zombie) return true;
  if (
    owner.process_start_time !== undefined &&
    processState.processStartTime !== undefined
  ) {
    return owner.process_start_time !== processState.processStartTime;
  }
  return leaseExpired;
}

export class FileOperationLock {
  private heartbeat?: NodeJS.Timeout;
  private heartbeatWrites: Promise<void> = Promise.resolve();
  private released = false;

  private constructor(
    readonly path: string,
    readonly metadata: LockMetadata,
    private readonly handle: FileHandle,
    heartbeatMs: number,
    private readonly leaseMs: number,
  ) {
    this.heartbeat = setInterval(() => {
      const now = Date.now();
      this.metadata.heartbeat_at = new Date(now).toISOString();
      this.metadata.lease_expires_at = new Date(now + this.leaseMs).toISOString();
      this.heartbeatWrites = this.heartbeatWrites
        .then(() => writeHandle(this.handle, `${JSON.stringify(this.metadata)}\n`))
        .catch(() => undefined);
    }, heartbeatMs);
    this.heartbeat.unref();
  }

  static async acquire(path: string, options: FileOperationLockOptions): Promise<FileOperationLock> {
    const staleLockMs = Math.max(250, options.staleLockMs ?? 60_000);
    const heartbeatMs = Math.max(100, options.heartbeatMs ?? Math.min(5_000, staleLockMs / 3));
    const processInspector = options.inspectProcess ?? inspectProcess;
    await mkdir(resolve(path, ".."), { recursive: true, mode: 0o700 });

    for (let attempt = 0; attempt < 4; attempt += 1) {
      let handle: FileHandle | undefined;
      try {
        handle = await open(path, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_RDWR, 0o600);
        const nowMs = Date.now();
        const now = new Date(nowMs).toISOString();
        const currentProcess = await processInspector(process.pid);
        const metadata: LockMetadata = {
          schema_version: LOCK_SCHEMA_VERSION,
          operation_id: options.operationId,
          kind: options.kind,
          pid: process.pid,
          project_root: options.projectRoot,
          created_at: now,
          heartbeat_at: now,
          process_start_time: currentProcess.processStartTime ?? CURRENT_PROCESS_START_TIME,
          lease_expires_at: new Date(nowMs + staleLockMs).toISOString(),
        };
        await writeHandle(handle, `${JSON.stringify(metadata)}\n`);
        return new FileOperationLock(path, metadata, handle, heartbeatMs, staleLockMs);
      } catch (error) {
        await handle?.close().catch(() => undefined);
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;

        let owner: LockMetadata | undefined;
        let mtimeMs = 0;
        try {
          const [contents, details] = await Promise.all([readFile(path, "utf8"), stat(path)]);
          owner = parseLock(contents);
          mtimeMs = details.mtimeMs;
        } catch (readError) {
          if ((readError as NodeJS.ErrnoException).code === "ENOENT") continue;
          throw readError;
        }

        const stale = await lockIsStale(owner, mtimeMs, staleLockMs, processInspector);
        if (!stale) throw new OperationLockedError(path, owner);
        const stalePath = `${path}.stale.${randomUUID()}`;
        try {
          await rename(path, stalePath);
          await unlink(stalePath).catch(() => undefined);
        } catch (renameError) {
          if ((renameError as NodeJS.ErrnoException).code !== "ENOENT") throw renameError;
        }
      }
    }
    throw new OperationLockedError(path);
  }

  async release(): Promise<void> {
    if (this.released) return;
    this.released = true;
    if (this.heartbeat) clearInterval(this.heartbeat);
    await this.heartbeatWrites;
    await this.handle.close().catch(() => undefined);
    try {
      const current = parseLock(await readFile(this.path, "utf8"));
      if (
        current?.operation_id === this.metadata.operation_id &&
        current.pid === this.metadata.pid &&
        current.process_start_time === this.metadata.process_start_time
      ) {
        await unlink(this.path);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

export class SecretStateError extends Error {
  constructor(readonly paths: string[]) {
    super(`Supervisor state contains secret material at: ${paths.join(", ")}`);
    this.name = "SecretStateError";
  }
}

export function assertSecretFree(value: unknown): void {
  const secretPaths: string[] = [];
  const seen = new WeakSet<object>();
  const visit = (current: unknown, path: string): void => {
    if (typeof current === "string") {
      if (!current.startsWith("env://") && !current.startsWith("exec://") && SECRET_VALUES.some((pattern) => pattern.test(current))) {
        secretPaths.push(path);
      }
      return;
    }
    if (current === null || typeof current !== "object") return;
    if (seen.has(current)) return;
    seen.add(current);
    if (Array.isArray(current)) {
      current.forEach((item, index) => visit(item, `${path}[${index}]`));
      return;
    }
    for (const [key, item] of Object.entries(current)) {
      const normalizedKey = key.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
      const isReference = typeof item === "string" && (item.startsWith("env://") || item.startsWith("exec://"));
      const isResourceIdentifier = typeof item === "string" && AWS_RESOURCE_ARN.test(item);
      if (SECRET_KEY.test(normalizedKey) && item !== undefined && item !== null && !isReference && !isResourceIdentifier) {
        secretPaths.push(`${path}.${key}`);
      } else {
        visit(item, `${path}.${key}`);
      }
    }
  };
  visit(value, "$state");
  if (secretPaths.length > 0) throw new SecretStateError(secretPaths);
}

export interface SupervisorState {
  schema_version: 1;
  logical_project_id?: string;
  project_name?: string;
  project_id: string;
  project_root: string;
  updated_at: string;
  active_operation?: {
    operation_id: string;
    kind: string;
    pid: number;
    started_at: string;
  };
  [key: string]: unknown;
}

export interface ServiceLogEntry {
  schema_version: 1;
  event_id: string;
  timestamp: string;
  service: string;
  stream: "stdout" | "stderr" | "event";
  level: "debug" | "info" | "warn" | "error";
  message: string;
  fields?: Record<string, unknown>;
  offset?: number;
}

export interface FollowServiceLogsOptions {
  service?: string;
  from?: "start" | "end" | number;
  follow?: boolean;
  pollMs?: number;
  signal?: AbortSignal;
}

export interface OperationContext {
  operationId: string;
  kind: string;
  signal: AbortSignal;
  supervisor: ProjectSupervisor;
  throwIfCancelled(): void;
}

export interface RunOperationOptions {
  operationId?: string;
  kind: string;
  signal?: AbortSignal;
  lockMode?: "exclusive" | "observational";
}

export interface ProjectSupervisorOptions {
  projectRoot: string;
  projectId?: string;
  logicalProjectId?: string;
  projectName?: string;
  stateHome?: string;
  staleLockMs?: number;
  heartbeatMs?: number;
  redactor?: Redactor;
}

function safeIdentifier(value: string, label: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(value)) throw new Error(`Invalid ${label}: ${value}`);
  return value;
}

/** A readable host-resource key that cannot collide across checkouts/worktrees. */
export function deriveRuntimeProjectId(logicalProjectId: string, projectRoot: string): string {
  const readable = logicalProjectId
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "") || "project";
  const rootHash = createHash("sha256").update(resolve(projectRoot)).digest("hex").slice(0, 12);
  const prefix = readable.slice(0, 35).replace(/[-.]+$/g, "") || "project";
  return `${prefix}-${rootHash}`;
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolveDelay) => {
    if (signal?.aborted) return resolveDelay();
    const finish = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", finish);
      resolveDelay();
    };
    const timer = setTimeout(finish, ms);
    signal?.addEventListener("abort", finish, { once: true });
  });
}

export class ProjectSupervisor {
  readonly projectRoot: string;
  readonly projectId: string;
  readonly logicalProjectId: string | undefined;
  readonly projectName: string | undefined;
  readonly stateDirectory: string;
  readonly statePath: string;
  readonly lockPath: string;
  readonly serviceLogsPath: string;
  readonly redactor: Redactor;
  private readonly staleLockMs: number | undefined;
  private readonly heartbeatMs: number | undefined;
  private readonly controllers = new Map<string, AbortController>();
  private appendChain: Promise<void> = Promise.resolve();

  constructor(options: ProjectSupervisorOptions) {
    this.projectRoot = resolve(options.projectRoot);
    this.projectId = safeIdentifier(
      options.projectId ?? createHash("sha256").update(this.projectRoot).digest("hex").slice(0, 24),
      "project id",
    );
    this.logicalProjectId = options.logicalProjectId;
    this.projectName = options.projectName;
    const stateHome = options.stateHome ?? process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state");
    this.stateDirectory = join(stateHome, "anbo", "projects", this.projectId);
    this.statePath = join(this.stateDirectory, "state.json");
    this.lockPath = join(this.stateDirectory, "operation.lock");
    this.serviceLogsPath = join(this.stateDirectory, "service-logs.jsonl");
    this.staleLockMs = options.staleLockMs;
    this.heartbeatMs = options.heartbeatMs;
    this.redactor = options.redactor ?? new Redactor();
  }

  async initialize(): Promise<void> {
    await mkdir(this.stateDirectory, { recursive: true, mode: 0o700 });
    await chmod(this.stateDirectory, 0o700);
  }

  async readState<T extends SupervisorState = SupervisorState>(): Promise<T | undefined> {
    await this.initialize();
    try {
      const state = JSON.parse(await readFile(this.statePath, "utf8")) as T;
      const stateRoot = typeof state.project_root === "string" ? resolve(state.project_root) : undefined;
      if (state.project_id !== this.projectId || stateRoot !== this.projectRoot) {
        throw new Error(
          `Project state ${this.statePath} belongs to ${String(state.project_id)} at ${String(state.project_root)}, ` +
          `not ${this.projectId} at ${this.projectRoot}`,
        );
      }
      return state;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  async writeState(state: Omit<SupervisorState, "schema_version" | "project_id" | "project_root" | "updated_at"> & Record<string, unknown>): Promise<SupervisorState> {
    const complete: SupervisorState = {
      ...state,
      schema_version: STATE_SCHEMA_VERSION,
      ...(this.logicalProjectId === undefined ? {} : { logical_project_id: this.logicalProjectId }),
      ...(this.projectName === undefined ? {} : { project_name: this.projectName }),
      project_id: this.projectId,
      project_root: this.projectRoot,
      updated_at: new Date().toISOString(),
    };
    assertSecretFree(complete);
    await this.initialize();
    const temporary = `${this.statePath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(complete, null, 2)}\n`, { mode: 0o600, flag: "wx" });
      await rename(temporary, this.statePath);
      await chmod(this.statePath, 0o600);
    } finally {
      await unlink(temporary).catch(() => undefined);
    }
    return complete;
  }

  async runOperation<T>(options: RunOperationOptions, handler: (context: OperationContext) => Promise<T>): Promise<T> {
    await this.initialize();
    const operationId = safeIdentifier(options.operationId ?? `op_${randomUUID()}`, "operation id");
    const lockMode = options.lockMode ??
      (OBSERVATIONAL_OPERATION_KINDS.has(options.kind) ? "observational" : "exclusive");
    const lock = lockMode === "exclusive"
      ? await FileOperationLock.acquire(this.lockPath, {
        operationId,
        kind: options.kind,
        projectRoot: this.projectRoot,
        ...(this.staleLockMs === undefined ? {} : { staleLockMs: this.staleLockMs }),
        ...(this.heartbeatMs === undefined ? {} : { heartbeatMs: this.heartbeatMs }),
      })
      : undefined;
    const controller = new AbortController();
    this.controllers.set(operationId, controller);
    const forwardAbort = () => controller.abort(options.signal?.reason);
    options.signal?.addEventListener("abort", forwardAbort, { once: true });
    if (options.signal?.aborted) forwardAbort();
    const cancellationPath = this.cancellationPath(operationId);
    const cancellationPoll = lockMode === "exclusive"
      ? setInterval(() => {
        void access(cancellationPath).then(
          () => controller.abort(new Error(`Operation ${operationId} was cancelled`)),
          () => undefined,
        );
      }, 200)
      : undefined;
    cancellationPoll?.unref();

    try {
      if (lockMode === "exclusive") {
        const previous = await this.readState();
        await this.writeState({
          ...(previous ?? {}),
          active_operation: {
            operation_id: operationId,
            kind: options.kind,
            pid: process.pid,
            started_at: new Date().toISOString(),
          },
        });
      }
      return await handler({
        operationId,
        kind: options.kind,
        signal: controller.signal,
        supervisor: this,
        throwIfCancelled: () => {
          if (controller.signal.aborted) {
            throw controller.signal.reason instanceof Error
              ? controller.signal.reason
              : new DOMException("The operation was aborted", "AbortError");
          }
        },
      });
    } finally {
      if (cancellationPoll !== undefined) clearInterval(cancellationPoll);
      options.signal?.removeEventListener("abort", forwardAbort);
      this.controllers.delete(operationId);
      await unlink(cancellationPath).catch(() => undefined);
      try {
        if (lockMode === "exclusive") {
          const current = await this.readState();
          if (current?.active_operation?.operation_id === operationId) {
            const { active_operation: _active, ...rest } = current;
            await this.writeState(rest);
          }
        }
      } finally {
        await lock?.release();
      }
    }
  }

  async cancelOperation(operationId: string, reason = "Cancellation requested"): Promise<boolean> {
    safeIdentifier(operationId, "operation id");
    const active = await this.readState();
    const controller = this.controllers.get(operationId);
    if (!controller && active?.active_operation?.operation_id !== operationId) return false;
    const marker = { operation_id: operationId, requested_at: new Date().toISOString(), reason };
    assertSecretFree(marker);
    const path = this.cancellationPath(operationId);
    await writeFile(path, `${JSON.stringify(marker)}\n`, { mode: 0o600 });
    await chmod(path, 0o600);
    controller?.abort(new Error(reason));
    return true;
  }

  async appendServiceLog(
    service: string,
    message: string,
    options: {
      stream?: ServiceLogEntry["stream"];
      level?: ServiceLogEntry["level"];
      fields?: Record<string, unknown>;
      timestamp?: string;
    } = {},
  ): Promise<ServiceLogEntry> {
    if (!service.trim()) throw new Error("Service name cannot be empty");
    const entry = this.redactor.redact<ServiceLogEntry>({
      schema_version: 1,
      event_id: randomUUID(),
      timestamp: options.timestamp ?? new Date().toISOString(),
      service,
      stream: options.stream ?? "event",
      level: options.level ?? "info",
      message,
      ...(options.fields === undefined ? {} : { fields: options.fields }),
    });
    let serialized = JSON.stringify(entry);
    if (Buffer.byteLength(serialized) > 256 * 1024) {
      entry.message = `${entry.message.slice(0, 16 * 1024)}...[truncated]`;
      entry.fields = { truncated: true };
      serialized = JSON.stringify(entry);
    }
    this.appendChain = this.appendChain.catch(() => undefined).then(async () => {
      await this.initialize();
      const handle = await open(this.serviceLogsPath, fsConstants.O_CREAT | fsConstants.O_APPEND | fsConstants.O_WRONLY, 0o600);
      try {
        await handle.chmod(0o600);
        await handle.write(`${serialized}\n`);
      } finally {
        await handle.close();
      }
    });
    await this.appendChain;
    return entry;
  }

  async *followServiceLogs(options: FollowServiceLogsOptions = {}): AsyncGenerator<ServiceLogEntry> {
    await this.initialize();
    const seed = await open(this.serviceLogsPath, fsConstants.O_CREAT | fsConstants.O_APPEND | fsConstants.O_WRONLY, 0o600);
    await seed.chmod(0o600);
    await seed.close();
    let offset = typeof options.from === "number" ? Math.max(0, options.from) : 0;
    if (options.from === "end") offset = (await stat(this.serviceLogsPath)).size;
    let pending = Buffer.alloc(0);
    let pendingStart = offset;
    const follow = options.follow ?? true;
    const pollMs = Math.max(20, options.pollMs ?? 250);

    while (!options.signal?.aborted) {
      const details = await stat(this.serviceLogsPath);
      if (details.size < offset) {
        offset = 0;
        pending = Buffer.alloc(0);
        pendingStart = 0;
      }
      if (details.size > offset) {
        const handle = await open(this.serviceLogsPath, "r");
        try {
          while (offset < details.size) {
            const length = Math.min(64 * 1024, details.size - offset);
            const buffer = Buffer.allocUnsafe(length);
            const { bytesRead } = await handle.read(buffer, 0, length, offset);
            if (bytesRead === 0) break;
            offset += bytesRead;
            const combined = Buffer.concat([pending, buffer.subarray(0, bytesRead)]);
            let lineStart = 0;
            for (let newline = combined.indexOf(0x0a, lineStart); newline >= 0; newline = combined.indexOf(0x0a, lineStart)) {
              const lineOffset = pendingStart + newline + 1;
              const line = combined.subarray(lineStart, newline).toString("utf8");
              lineStart = newline + 1;
              if (!line) continue;
              let entry: ServiceLogEntry;
              try {
                entry = JSON.parse(line) as ServiceLogEntry;
              } catch {
                entry = {
                  schema_version: 1,
                  event_id: randomUUID(),
                  timestamp: new Date().toISOString(),
                  service: "anbo.supervisor",
                  stream: "event",
                  level: "error",
                  message: "Skipped a malformed persisted service log entry",
                };
              }
              if (!options.service || entry.service === options.service) yield { ...entry, offset: lineOffset };
            }
            pending = Buffer.from(combined.subarray(lineStart));
            pendingStart = offset - pending.length;
          }
        } finally {
          await handle.close();
        }
      }
      if (!follow) break;
      await delay(pollMs, options.signal);
    }
  }

  private cancellationPath(operationId: string): string {
    return join(this.stateDirectory, `cancel.${operationId}.json`);
  }
}

export { REDACTED };

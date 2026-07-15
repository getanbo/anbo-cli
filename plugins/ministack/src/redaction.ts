export const REDACTED = "[REDACTED]";

export interface RedactionPattern {
  pattern: RegExp;
  replacement?: string;
}

export interface RedactorOptions {
  replacement?: string;
  patterns?: RedactionPattern[];
  sensitiveKeys?: RegExp;
  useDefaultPatterns?: boolean;
}

const DEFAULT_SENSITIVE_KEYS =
  /(?:^|[_-])(?:authorization|cookie|credential|database_url|dsn|password|passwd|private_key|secret|session_token|token)(?:$|[_-])/i;

const DEFAULT_PATTERNS: RedactionPattern[] = [
  { pattern: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g },
  { pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g },
  { pattern: /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?):\/\/[^\s/@:]+:[^\s/@]+@/gi },
];

function globalPattern(pattern: RegExp): RegExp {
  const flags = new Set(pattern.flags.replace("y", ""));
  flags.add("g");
  return new RegExp(pattern.source, [...flags].join(""));
}

function cloneAndRedact(
  value: unknown,
  redactString: (input: string) => string,
  isSensitiveKey: (key: string) => boolean,
  replacement: string,
  seen: WeakMap<object, unknown>,
): unknown {
  if (typeof value === "string") {
    return redactString(value);
  }
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (value instanceof Error) {
    return {
      name: value.name,
      message: redactString(value.message),
      stack: value.stack ? redactString(value.stack) : undefined,
    };
  }

  const previous = seen.get(value);
  if (previous !== undefined) {
    return "[CIRCULAR]";
  }

  if (Array.isArray(value)) {
    const copy: unknown[] = [];
    seen.set(value, copy);
    for (const item of value) {
      copy.push(cloneAndRedact(item, redactString, isSensitiveKey, replacement, seen));
    }
    return copy;
  }

  const copy: Record<string, unknown> = {};
  seen.set(value, copy);
  for (const [key, item] of Object.entries(value)) {
    const safeKey = redactString(key);
    copy[safeKey] = isSensitiveKey(key)
      ? replacement
      : cloneAndRedact(item, redactString, isSensitiveKey, replacement, seen);
  }
  return copy;
}

/** A per-run redactor. Register resolved secrets before starting child processes. */
export class Redactor {
  readonly replacement: string;
  readonly sensitiveKeys: RegExp;
  private readonly secrets = new Set<string>();
  private readonly patterns: RedactionPattern[];

  constructor(options: RedactorOptions = {}) {
    this.replacement = options.replacement ?? REDACTED;
    this.sensitiveKeys = options.sensitiveKeys ?? DEFAULT_SENSITIVE_KEYS;
    this.patterns = [
      ...(options.useDefaultPatterns === false ? [] : DEFAULT_PATTERNS),
      ...(options.patterns ?? []),
    ].map(({ pattern, replacement }) => ({
      pattern: globalPattern(pattern),
      ...(replacement === undefined ? {} : { replacement }),
    }));
  }

  registerSecret(secret: string | undefined | null): void {
    if (secret) {
      this.secrets.add(secret);
    }
  }

  registerSecrets(secrets: Iterable<string | undefined | null>): void {
    for (const secret of secrets) {
      this.registerSecret(secret);
    }
  }

  registerPattern(pattern: RegExp, replacement?: string): void {
    this.patterns.push({
      pattern: globalPattern(pattern),
      ...(replacement === undefined ? {} : { replacement }),
    });
  }

  redactString(input: string): string {
    let output = input;
    const secrets = [...this.secrets].sort((a, b) => b.length - a.length);
    for (const secret of secrets) {
      output = output.split(secret).join(this.replacement);
    }
    for (const { pattern, replacement } of this.patterns) {
      pattern.lastIndex = 0;
      output = output.replace(pattern, replacement ?? this.replacement);
    }
    return output;
  }

  redact<T>(value: T): T {
    return cloneAndRedact(
      value,
      (input) => this.redactString(input),
      (key) => {
        this.sensitiveKeys.lastIndex = 0;
        return this.sensitiveKeys.test(key);
      },
      this.replacement,
      new WeakMap(),
    ) as T;
  }

  redactEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
    return this.redact(environment);
  }
}

export function redactWithSecrets<T>(value: T, secrets: Iterable<string>): T {
  const redactor = new Redactor();
  redactor.registerSecrets(secrets);
  return redactor.redact(value);
}

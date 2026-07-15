import type { JsonObject, JsonValue } from "@getanbo/plugin-sdk";

const REDACTED = "[REDACTED]";
const SENSITIVE_KEY = /(?:authorization|credential|database[_-]?url|password|secret|token|(?:^|[_-])key$)/iu;
const SENSITIVE_FLAG = /(?:authorization|credential|database[-_]?url|password|secret|token|(?:^|[-_])key)$/iu;

export function redactText(value: string, secretValues: string[] = []): string {
  let redacted = value
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/giu, `Bearer ${REDACTED}`)
    .replace(/(postgres(?:ql)?:\/\/[^:\s/]+:)[^@\s/]+@/giu, `$1${REDACTED}@`)
    .replace(/\bAKIA[0-9A-Z]{16}\b/gu, REDACTED);
  for (const secret of secretValues.filter((item) => item.length >= 4)) {
    redacted = redacted.split(secret).join(REDACTED);
  }
  return redacted;
}

export function redactObject(value: JsonObject, secretValues: string[] = []): JsonObject {
  return redactValue(value, secretValues) as JsonObject;
}

export function redactArgv(argv: string[]): { argv: string[]; secrets: string[] } {
  const redacted: string[] = [];
  const secrets: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index] ?? "";
    if (!value.startsWith("--")) {
      redacted.push(redactText(value));
      continue;
    }
    const separator = value.indexOf("=");
    const name = value.slice(2, separator < 0 ? undefined : separator);
    if (!SENSITIVE_FLAG.test(name)) {
      redacted.push(redactText(value));
      continue;
    }
    if (separator >= 0) {
      const secret = value.slice(separator + 1);
      if (secret) secrets.push(secret);
      redacted.push(`${value.slice(0, separator + 1)}${REDACTED}`);
      continue;
    }
    redacted.push(value);
    const secret = argv[index + 1];
    if (secret !== undefined && !secret.startsWith("--")) {
      secrets.push(secret);
      redacted.push(REDACTED);
      index += 1;
    }
  }
  return { argv: redacted, secrets };
}

function redactValue(value: JsonValue, secretValues: string[], key = ""): JsonValue {
  if (SENSITIVE_KEY.test(key) && value !== null) {
    return REDACTED;
  }
  if (typeof value === "string") {
    return redactText(value, secretValues);
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item, secretValues));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([childKey, childValue]) => [
        childKey,
        redactValue(childValue, secretValues, childKey),
      ]),
    );
  }
  return value;
}

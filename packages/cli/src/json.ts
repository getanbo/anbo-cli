import type { JsonObject, JsonValue } from "@getanbo/plugin-sdk";

const MAX_DEPTH = 20;
const MAX_CONTAINER_ENTRIES = 1_000;
const MAX_TOTAL_ENTRIES = 10_000;
const MAX_STRING_LENGTH = 64 * 1024;
const MAX_TOTAL_STRING_LENGTH = 1024 * 1024;
const TRUNCATED = "[...truncated...]";

interface JsonBudget {
  entries: number;
  stringLength: number;
}

/** Converts untrusted plugin values to bounded JSON without throwing. */
export function safeJsonValue(value: unknown): JsonValue {
  try {
    return normalize(value, new WeakSet<object>(), 0, {
      entries: MAX_TOTAL_ENTRIES,
      stringLength: MAX_TOTAL_STRING_LENGTH,
    });
  } catch {
    return "[UNSERIALIZABLE]";
  }
}

export function safeJsonObject(value: unknown): JsonObject {
  const normalized = safeJsonValue(value);
  return normalized !== null && typeof normalized === "object" && !Array.isArray(normalized)
    ? normalized
    : { value: normalized };
}

function normalize(
  value: unknown,
  seen: WeakSet<object>,
  depth: number,
  budget: JsonBudget,
): JsonValue {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") return boundedString(value, budget);
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
  if (typeof value === "bigint") return boundedString(value.toString(), budget);
  if (typeof value === "undefined") return null;
  if (typeof value === "symbol" || typeof value === "function") {
    return boundedString(String(value), budget);
  }
  if (depth >= MAX_DEPTH) return "[MAX_DEPTH]";
  if (seen.has(value)) return "[CIRCULAR]";
  seen.add(value);
  try {
    if (value instanceof Date) {
      return boundedString(Number.isNaN(value.valueOf()) ? "Invalid Date" : value.toISOString(), budget);
    }
    if (value instanceof Error) {
      return {
        name: boundedString(value.name, budget),
        message: normalize(value.message, seen, depth + 1, budget),
      };
    }
    if (Array.isArray(value)) {
      const items: JsonValue[] = [];
      const containerLimit = Math.min(value.length, MAX_CONTAINER_ENTRIES);
      for (let index = 0; index < containerLimit; index += 1) {
        if (budget.entries <= 0) break;
        budget.entries -= 1;
        try {
          items.push(normalize(value[index], seen, depth + 1, budget));
        } catch {
          items.push("[UNSERIALIZABLE]");
        }
      }
      if (items.length < value.length) {
        items.push(`[${value.length - items.length} more entries]`);
      }
      return items;
    }
    const result = Object.create(null) as JsonObject;
    let enumerated = 0;
    let processed = 0;
    let truncated = false;
    try {
      for (const key in value) {
        if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
        if (enumerated >= MAX_CONTAINER_ENTRIES) {
          truncated = true;
          break;
        }
        enumerated += 1;
        if (budget.entries <= 0) {
          truncated = true;
          break;
        }
        budget.entries -= 1;
        processed += 1;
        const normalizedKey = boundedString(key, budget);
        try {
          result[normalizedKey] = normalize(
            (value as Record<string, unknown>)[key],
            seen,
            depth + 1,
            budget,
          );
        } catch {
          result[normalizedKey] = "[UNSERIALIZABLE]";
        }
      }
    } catch {
      if (processed === 0) return "[UNSERIALIZABLE]";
      truncated = true;
    }
    if (truncated) result["__truncated_entries__"] = true;
    return result;
  } finally {
    seen.delete(value);
  }
}

function boundedString(value: string, budget: JsonBudget): string {
  const available = Math.max(0, Math.min(MAX_STRING_LENGTH, budget.stringLength));
  const consumed = Math.min(value.length, available);
  budget.stringLength -= consumed;
  if (value.length <= available) return value;
  return `${value.slice(0, Math.max(0, available - TRUNCATED.length))}${TRUNCATED}`;
}

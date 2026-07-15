import { cloneEndpointForContainer, type CloneLease } from "./clones.js";

interface LambdaDescription {
  FunctionName?: string;
  Environment?: { Variables?: Record<string, string> };
}

interface ListFunctionsResponse {
  Functions?: LambdaDescription[];
  NextMarker?: string;
}

export interface LambdaCloneOverlayResult {
  inspected: number;
  updated: string[];
}

/**
 * Injects short-lived clone bindings after Terraform apply. Clone secrets never
 * become Terraform variables, plans, or state. Functions opt in with the
 * non-secret ANBO_CLONE_REQUIRED marker in their Terraform environment.
 */
export async function injectLambdaCloneBindings(
  endpoint: string,
  clones: Readonly<Partial<Record<"postgres" | "dynamodb", CloneLease>>>,
  options: { fetch?: typeof globalThis.fetch; signal?: AbortSignal } = {},
): Promise<LambdaCloneOverlayResult> {
  if (clones.postgres === undefined && clones.dynamodb === undefined) {
    return { inspected: 0, updated: [] };
  }

  const fetcher = options.fetch ?? globalThis.fetch;
  const functions = await listFunctions(endpoint, fetcher, options.signal);
  const updated: string[] = [];
  for (const fn of functions) {
    const name = fn.FunctionName;
    const current = fn.Environment?.Variables ?? {};
    const required = new Set(
      (current["ANBO_CLONE_REQUIRED"] ?? "")
        .split(",")
        .map((value) => value.trim().toLowerCase())
        .filter(Boolean),
    );
    if (name === undefined || required.size === 0) continue;

    const overlay: Record<string, string> = {};
    const postgres = clones.postgres;
    if (required.has("postgres")) {
      if (postgres?.engine !== "postgres") {
        throw new Error(`Lambda ${name} requires a PostgreSQL clone, but none is configured`);
      }
      overlay["ANBO_POSTGRES_URL"] = cloneEndpointForContainer(postgres);
    }

    const dynamodb = clones.dynamodb;
    if (required.has("dynamodb")) {
      if (dynamodb?.engine !== "dynamodb") {
        throw new Error(`Lambda ${name} requires a DynamoDB clone, but none is configured`);
      }
      overlay["ANBO_DYNAMODB_CLONE_ENDPOINT"] = cloneEndpointForContainer(dynamodb);
      overlay["ANBO_DYNAMODB_CLONE_REGION"] = dynamodb.region;
      overlay["ANBO_DYNAMODB_CLONE_ACCESS_KEY_ID"] = dynamodb.accessKeyId;
      overlay["ANBO_DYNAMODB_CLONE_SECRET_ACCESS_KEY"] = dynamodb.secretAccessKey;
      overlay["ANBO_DYNAMODB_CLONE_SESSION_TOKEN"] = dynamodb.sessionToken;
    }

    await lambdaRequest(endpoint, fetcher, options.signal, "PUT", `/2015-03-31/functions/${encodeURIComponent(name)}/configuration`, {
      Environment: { Variables: { ...current, ...overlay } },
    });
    updated.push(name);
  }
  return { inspected: functions.length, updated };
}

async function listFunctions(
  endpoint: string,
  fetcher: typeof globalThis.fetch,
  signal?: AbortSignal,
): Promise<LambdaDescription[]> {
  const functions: LambdaDescription[] = [];
  let marker: string | undefined;
  do {
    const query = marker === undefined ? "" : `?Marker=${encodeURIComponent(marker)}`;
    const response = await lambdaRequest<ListFunctionsResponse>(
      endpoint,
      fetcher,
      signal,
      "GET",
      `/2015-03-31/functions/${query}`,
    );
    functions.push(...(response.Functions ?? []));
    marker = response.NextMarker;
  } while (marker !== undefined && marker.length > 0);
  return functions;
}

async function lambdaRequest<T = unknown>(
  endpoint: string,
  fetcher: typeof globalThis.fetch,
  signal: AbortSignal | undefined,
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const response = await fetcher(`${endpoint.replace(/\/+$/, "")}${path}`, {
    method,
    headers: {
      accept: "application/json",
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    ...(signal === undefined ? {} : { signal }),
  });
  const text = await response.text();
  if (!response.ok) {
    let detail = `HTTP ${response.status}`;
    try {
      const parsed = JSON.parse(text) as Record<string, unknown>;
      const message = parsed["message"] ?? parsed["Message"] ?? parsed["error"];
      if (typeof message === "string") detail = message;
    } catch {
      // Never include an arbitrary response body: a local extension may echo secrets.
    }
    throw new Error(`MiniStack Lambda ${method} ${path} failed: ${detail}`);
  }
  if (text.length === 0) return {} as T;
  return JSON.parse(text) as T;
}

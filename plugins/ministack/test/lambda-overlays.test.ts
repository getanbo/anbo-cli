import assert from "node:assert/strict";
import test from "node:test";

import { injectLambdaCloneBindings } from "../src/runtime/lambda-overlays.js";
import type { DynamoDbCloneLease, PostgresCloneLease } from "../src/runtime/clones.js";

const postgres: PostgresCloneLease = {
  engine: "postgres",
  metadata: { engine: "postgres", provider: "external", branch_id: "pg", branch_name: "pg", owned: false },
  databaseUrl: "postgresql://user:password@clone.example.test/orders",
};

const dynamodb: DynamoDbCloneLease = {
  engine: "dynamodb",
  metadata: { engine: "dynamodb", provider: "external", branch_id: "ddb", branch_name: "ddb", owned: false },
  endpointUrl: "https://clone.example.test/dynamodb",
  region: "eu-west-1",
  accessKeyId: "clone-access",
  secretAccessKey: "clone-secret",
  sessionToken: "clone-session",
  tables: ["Carts"],
};

test("injects opted-in clone bindings without sending them through Terraform", async () => {
  const requests: Array<{ method: string; path: string; body?: Record<string, unknown> }> = [];
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const body = init?.body === undefined ? undefined : JSON.parse(String(init.body)) as Record<string, unknown>;
    requests.push({ method: init?.method ?? "GET", path: `${url.pathname}${url.search}`, ...(body === undefined ? {} : { body }) });
    if (url.pathname.endsWith("/functions/")) {
      return Response.json({
        Functions: [
          { FunctionName: "checkout", Environment: { Variables: { ANBO_CLONE_REQUIRED: "postgres,dynamodb", MODE: "checkout" } } },
          { FunctionName: "worker", Environment: { Variables: { MODE: "worker" } } },
        ],
      });
    }
    return Response.json({ FunctionName: "checkout" });
  };

  const result = await injectLambdaCloneBindings("http://127.0.0.1:4566", { postgres, dynamodb }, { fetch: fetcher });
  assert.deepEqual(result, { inspected: 2, updated: ["checkout"] });
  assert.equal(requests.length, 2);
  const variables = ((requests[1]?.body?.["Environment"] as Record<string, unknown>)["Variables"] as Record<string, string>);
  assert.equal(variables["MODE"], "checkout");
  assert.equal(variables["ANBO_POSTGRES_URL"], postgres.databaseUrl);
  assert.equal(variables["ANBO_DYNAMODB_CLONE_SECRET_ACCESS_KEY"], dynamodb.secretAccessKey);
});

test("fails clearly when a function requires an unavailable clone", async () => {
  const fetcher: typeof fetch = async () => Response.json({
    Functions: [{ FunctionName: "checkout", Environment: { Variables: { ANBO_CLONE_REQUIRED: "postgres" } } }],
  });
  await assert.rejects(
    injectLambdaCloneBindings("http://127.0.0.1:4566", { dynamodb }, { fetch: fetcher }),
    /requires a PostgreSQL clone/,
  );
});

import assert from "node:assert/strict";
import test from "node:test";

import {
  cloneEndpointForContainer,
  type DynamoDbCloneLease,
  type PostgresCloneLease,
} from "../src/runtime/clones.js";
import { injectLambdaCloneBindings } from "../src/runtime/lambda-overlays.js";
import type { CommandExecutor, RuntimeCommandOptions, RuntimeCommandResult } from "../src/runtime/ministack.js";
import { startDeclaredServices, type ServiceRuntimeContext } from "../src/runtime/services.js";

class RecordingExecutor implements CommandExecutor {
  readonly calls: Array<{ command: string; args: string[]; options?: RuntimeCommandOptions }> = [];

  async run(command: string, args: readonly string[], options?: RuntimeCommandOptions): Promise<RuntimeCommandResult> {
    this.calls.push({ command, args: [...args], ...(options === undefined ? {} : { options }) });
    return { code: 0, stdout: "container-id\n", stderr: "" };
  }
}

test("container clone endpoints translate only external loopback hosts", () => {
  const localhostPostgres = postgresLease("external", "postgresql://user:password@localhost:5432/orders?sslmode=disable");
  const ipv4Dynamo = dynamoLease("external", "http://127.0.0.1:8800/dynamodb");
  const ipv6Dynamo = dynamoLease("external", "http://[::1]:8801/dynamodb");
  const externalRemote = dynamoLease("external", "https://clone.example.test/dynamodb");
  const cloudLoopback = dynamoLease("anbo-cloud", "http://127.0.0.1:9900/cloud-issued");

  assert.equal(
    cloneEndpointForContainer(localhostPostgres),
    "postgresql://user:password@host.docker.internal:5432/orders?sslmode=disable",
  );
  assert.equal(cloneEndpointForContainer(ipv4Dynamo), "http://host.docker.internal:8800/dynamodb");
  assert.equal(cloneEndpointForContainer(ipv6Dynamo), "http://host.docker.internal:8801/dynamodb");
  assert.equal(cloneEndpointForContainer(externalRemote), externalRemote.endpointUrl);
  assert.equal(cloneEndpointForContainer(cloudLoopback), cloudLoopback.endpointUrl);

  assert.equal(localhostPostgres.databaseUrl, "postgresql://user:password@localhost:5432/orders?sslmode=disable");
  assert.equal(ipv4Dynamo.endpointUrl, "http://127.0.0.1:8800/dynamodb");
});

test("declared Docker services receive host-reachable PostgreSQL and DynamoDB clone URLs", async () => {
  const commands = new RecordingExecutor();
  const postgres = postgresLease("external", "postgresql://user:password@localhost:5432/orders");
  const dynamodb = dynamoLease("external", "http://127.0.0.1:8800/dynamodb");
  const context: ServiceRuntimeContext = {
    projectId: "checkout",
    networkName: "anbo-checkout-app",
    miniStackEndpoint: "http://ministack:4566",
    terraformOutputs: {},
    clones: { postgres, dynamodb },
    builds: {},
    environment: {},
  };

  await startDeclaredServices({
    api: {
      image: "api:test",
      dynamodb_plane: "clone",
      environment: { DATABASE_URL: "${clone.postgres.database_url}" },
    },
  }, context, { commands });

  const run = commands.calls.find((call) => call.args[0] === "run");
  assert.ok(run);
  assert.ok(run.args.includes("DATABASE_URL=postgresql://user:password@host.docker.internal:5432/orders"));
  assert.ok(run.args.includes("AWS_ENDPOINT_URL_DYNAMODB=http://host.docker.internal:8800/dynamodb"));
  assert.ok(run.args.includes("ANBO_DYNAMODB_CLONE_ENDPOINT=http://host.docker.internal:8800/dynamodb"));
  assert.ok(run.args.includes("host.docker.internal:host-gateway"));
});

test("MiniStack Lambda overlays receive host-reachable external clone URLs", async () => {
  let update: Record<string, unknown> | undefined;
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/functions/")) {
      return Response.json({
        Functions: [{
          FunctionName: "checkout",
          Environment: { Variables: { ANBO_CLONE_REQUIRED: "postgres,dynamodb" } },
        }],
      });
    }
    update = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return Response.json({ FunctionName: "checkout" });
  };

  await injectLambdaCloneBindings("http://127.0.0.1:4566", {
    postgres: postgresLease("external", "postgresql://user:password@localhost:5432/orders"),
    dynamodb: dynamoLease("external", "http://[::1]:8800/dynamodb"),
  }, { fetch: fetcher });

  const variables = ((update?.["Environment"] as Record<string, unknown>)["Variables"] as Record<string, string>);
  assert.equal(variables["ANBO_POSTGRES_URL"], "postgresql://user:password@host.docker.internal:5432/orders");
  assert.equal(variables["ANBO_DYNAMODB_CLONE_ENDPOINT"], "http://host.docker.internal:8800/dynamodb");
});

function postgresLease(
  provider: "external" | "anbo-cloud",
  databaseUrl: string,
): PostgresCloneLease {
  return {
    engine: "postgres",
    metadata: { engine: "postgres", provider, branch_id: "pg", branch_name: "pg", owned: false },
    databaseUrl,
  };
}

function dynamoLease(
  provider: "external" | "anbo-cloud",
  endpointUrl: string,
): DynamoDbCloneLease {
  return {
    engine: "dynamodb",
    metadata: { engine: "dynamodb", provider, branch_id: "ddb", branch_name: "ddb", owned: false },
    endpointUrl,
    region: "us-east-1",
    accessKeyId: "clone-access",
    secretAccessKey: "clone-secret",
    sessionToken: "clone-session",
    tables: [],
  };
}

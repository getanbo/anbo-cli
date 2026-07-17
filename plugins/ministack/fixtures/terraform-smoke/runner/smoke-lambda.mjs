import assert from "node:assert/strict";
import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";

const endpoint = required("ANBO_MINISTACK_ENDPOINT");
const runId = required("ANBO_RUN_ID");
const correlationId = required("ANBO_TEST_RUN_ID");
const credentials = { accessKeyId: "000000000000", secretAccessKey: "test" };
const lambda = new LambdaClient({ endpoint, region: "us-east-1", credentials });

event("test.started", { endpoint });
if (process.env.ANBO_FORCE_TEST_FAILURE === "1") {
  event("test.assertion", {
    name: "lambda.forced-failure",
    status: "failed",
    message: "Acceptance fixture forced the lambda-invoke suite to fail"
  });
  process.exitCode = 42;
} else {
  const invoked = await lambda.send(new InvokeCommand({
    FunctionName: required("ANBO_TERRAFORM_OUTPUT_FUNCTION_NAME"),
    Payload: Buffer.from(JSON.stringify({ smoke: true })),
  }));
  const rawPayload = Buffer.from(invoked.Payload ?? []).toString("utf8");
  if (invoked.FunctionError !== undefined) {
    throw new Error(`Lambda invocation returned ${invoked.FunctionError}: ${rawPayload.slice(0, 4_096)}`);
  }
  const payload = JSON.parse(rawPayload);
  assert.equal(payload.ok, true);
  passed("lambda.invoke");
  event("test.finished", { status: "passed" });
}

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required; invoke this smoke through anbo test`);
  return value;
}

function passed(name) {
  event("test.assertion", { name, status: "passed" });
}

function event(kind, fields) {
  process.stdout.write(`${JSON.stringify({
    schema_version: 1,
    kind,
    name: fields.name ?? "lambda-invoke",
    ...fields,
    run_id: runId,
    correlation_id: correlationId
  })}\n`);
}

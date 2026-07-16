import assert from "node:assert/strict";
import { ListTablesCommand, DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DecryptCommand,
  EncryptCommand,
  GenerateDataKeyCommand,
  KMSClient,
} from "@aws-sdk/client-kms";
import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";
import { ListBucketsCommand, S3Client } from "@aws-sdk/client-s3";
import { ListQueuesCommand, SQSClient } from "@aws-sdk/client-sqs";

const endpoint = required("ANBO_MINISTACK_ENDPOINT");
const runId = required("ANBO_RUN_ID");
const correlationId = required("ANBO_TEST_RUN_ID");
const credentials = { accessKeyId: "000000000000", secretAccessKey: "test" };
const options = { endpoint, region: "us-east-1", credentials };
const s3 = new S3Client({ ...options, forcePathStyle: true });
const sqs = new SQSClient(options);
const dynamodb = new DynamoDBClient(options);
const kms = new KMSClient(options);
const lambda = new LambdaClient(options);

event("test.started", { endpoint });
const [buckets, queues, tables] = await Promise.all([
  s3.send(new ListBucketsCommand({})),
  sqs.send(new ListQueuesCommand({})),
  dynamodb.send(new ListTablesCommand({})),
]);
assert.ok(buckets.Buckets?.some((bucket) => bucket.Name === required("ANBO_TERRAFORM_OUTPUT_BUCKET")));
assert.ok(queues.QueueUrls?.includes(required("ANBO_TERRAFORM_OUTPUT_QUEUE_URL")));
assert.ok(tables.TableNames?.includes(required("ANBO_TERRAFORM_OUTPUT_TABLE")));
passed("terraform.resources");

const kmsKeyId = required("ANBO_TERRAFORM_OUTPUT_KMS_KEY_ID");
const dataKey = await kms.send(new GenerateDataKeyCommand({
  KeyId: kmsKeyId,
  KeySpec: "AES_256",
}));
assert.equal(dataKey.Plaintext?.byteLength, 32);
assert.ok((dataKey.CiphertextBlob?.byteLength ?? 0) > 0);
passed("kms.generate-data-key");

const cleartext = Buffer.from("anbo-ministack-native-platform");
const encrypted = await kms.send(new EncryptCommand({ KeyId: kmsKeyId, Plaintext: cleartext }));
assert.ok((encrypted.CiphertextBlob?.byteLength ?? 0) > 0);
const decrypted = await kms.send(new DecryptCommand({ CiphertextBlob: encrypted.CiphertextBlob }));
assert.deepEqual(Buffer.from(decrypted.Plaintext ?? []), cleartext);
passed("kms.encrypt-decrypt");

const invoked = await lambda.send(new InvokeCommand({
  FunctionName: required("ANBO_TERRAFORM_OUTPUT_FUNCTION_NAME"),
  Payload: Buffer.from(JSON.stringify({ smoke: true })),
}));
assert.equal(invoked.FunctionError, undefined);
const payload = JSON.parse(Buffer.from(invoked.Payload ?? []).toString("utf8"));
assert.equal(payload.ok, true);
passed("lambda.invoke");
event("test.finished", { status: "passed" });

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
    name: fields.name ?? "terraform-smoke",
    ...fields,
    run_id: runId,
    correlation_id: correlationId
  })}\n`);
}

import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { realpathSync } from "node:fs";
import test from "node:test";
import { createDefaultManifest, loadManifest, parseManifest, writeManifest } from "../src/config.js";
import { discoverProject, discoverSdks, discoverTerraform } from "../src/discovery.js";
import { routeTerraformVariableFiles } from "../src/terraform-layout.js";
import { AnboError, type DiscoveryReport, type SandboxManifest } from "../src/types.js";

function discovery(root: string): DiscoveryReport {
  return {
    root,
    terraform: [{ path: "infra", files: ["infra/main.tf"], variable_files: ["infra/dev.tfvars"] }],
    sdk: [],
    dockerfiles: [{ path: "Dockerfile", context: "." }]
  };
}

function validManifest(root = "/tmp/order-flow"): SandboxManifest {
  const manifest = createDefaultManifest(discovery(root));
  manifest.builds["order-flow"] = { context: ".", dockerfile: "Dockerfile" };
  manifest.builds["lambda-zip"] = {
    context: ".",
    command: ["npm", "run", "build:lambda"],
    outputs: ["dist/lambda.zip"]
  };
  manifest.services["api"] = {
    build: "order-flow",
    environment: { LOG_LEVEL: "info" },
    dynamodb_plane: "clone"
  };
  manifest.tests["smoke"] = { command: ["npm", "run", "smoke"], service: "api", default: true };
  manifest.data = {
    postgres: { provider: "external", endpoint: "env://POSTGRES_CLONE_URL", credentials: { token: "exec://anbo auth print-token" } },
    dynamodb: { provider: "anbo-cloud", source: "production-sanitized", region: "us-east-1" }
  };
  manifest.adapters["custom-clone"] = {
    executable: "./bin/custom-clone",
    protocol: 2,
    digest: `sha256:${"a".repeat(64)}`,
    environment: { TOKEN: "env://CUSTOM_CLONE_TOKEN" }
  };
  return manifest;
}

test("manifest v2 accepts cloud and externally supplied clones without literal secrets", () => {
  const manifest = validManifest();
  assert.equal(parseManifest(manifest), manifest);
  assert.equal(
    manifest.ministack.image,
    "ghcr.io/getanbo/anbo-ministack@sha256:cf29ce9cacd3982531b5f5bd48a7b46c10acaf4f44a10fb25831b3073c26b204",
  );
  assert.deepEqual(manifest.builds["lambda-zip"]?.outputs, ["dist/lambda.zip"]);
});

test("manifest v2 accepts tagged and tagless immutable full image references", () => {
  const tagged = validManifest();
  tagged.ministack.image = `ministackorg/ministack:full@sha256:${"a".repeat(64)}`;
  tagged.ministack.digest = `sha256:${"a".repeat(64)}`;
  assert.equal(parseManifest(tagged), tagged);

  const tagless = validManifest();
  assert.equal(parseManifest(tagless), tagless);
});

test("manifest v2 rejects literal clone URLs and credentials", () => {
  const endpoint = structuredClone(validManifest());
  endpoint.data.postgres = { provider: "external", endpoint: "postgresql://user:password@clone.example/db" as `env://${string}` };
  assert.throws(() => parseManifest(endpoint), (error: unknown) => {
    assert.ok(error instanceof AnboError);
    assert.equal(error.code, "ANBO_CONFIG_INVALID");
    assert.match(error.message, /env:\/\/NAME or exec:\/\/COMMAND/);
    return true;
  });

  const environment = structuredClone(validManifest());
  environment.services["api"]!.environment = { DATABASE_URL: "not-a-reference" };
  assert.throws(() => parseManifest(environment), /clone credentials and database URLs/);
});

test("manifest validation rejects unknown keys and cross-reference mistakes", () => {
  const unknown = structuredClone(validManifest()) as SandboxManifest & { surprise?: boolean };
  unknown.surprise = true;
  assert.throws(() => parseManifest(unknown), /\$\.surprise is not a supported property/);

  const badBuild = structuredClone(validManifest());
  badBuild.services["api"]!.build = "missing";
  assert.throws(() => parseManifest(badBuild), /references unknown build missing/);

  const unownedVariableFile = structuredClone(validManifest());
  unownedVariableFile.terraform.variable_files = ["shared.tfvars"];
  assert.throws(() => parseManifest(unownedVariableFile), /not inside any configured Terraform root/);
});

test("manifest writes atomically and loads only validated regular files", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "anbo-config-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, ".anbo", "sandbox.json");
  const manifest = validManifest(root);
  writeManifest(path, manifest);
  assert.deepEqual(loadManifest(root).manifest, manifest);
  assert.equal(JSON.parse(readFileSync(path, "utf8")).schema_version, 2);
  assert.throws(() => writeManifest(path, manifest), /already exists/);
});

test("discovery deterministically finds Terraform, SDKs, and Dockerfiles", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "anbo-discovery-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  mkdirSync(join(root, ".git"));
  mkdirSync(join(root, "infra"));
  mkdirSync(join(root, "services", "python"), { recursive: true });
  mkdirSync(join(root, "services", "go"), { recursive: true });
  mkdirSync(join(root, "services", "java"), { recursive: true });
  mkdirSync(join(root, "node_modules", "ignored"), { recursive: true });
  writeFileSync(join(root, "infra", "main.tf"), 'resource "aws_s3_bucket" "assets" {}\n');
  writeFileSync(join(root, "infra", "outputs.tf.json"), '{"output":{"bucket":{"value":"ok"}}}\n');
  writeFileSync(join(root, "infra", "dev.tfvars"), 'stage = "dev"\n');
  writeFileSync(join(root, "package.json"), JSON.stringify({ dependencies: { "@aws-sdk/client-s3": "3.0.0" } }));
  writeFileSync(join(root, "services", "python", "worker.py"), "import boto3\n");
  writeFileSync(join(root, "services", "go", "go.mod"), "module demo\nrequire github.com/aws/aws-sdk-go-v2 v1.0.0\n");
  writeFileSync(join(root, "services", "java", "App.java"), "import software.amazon.awssdk.services.sqs.SqsClient;\n");
  writeFileSync(join(root, "Dockerfile"), "FROM scratch\n");
  writeFileSync(join(root, "services", "python", "Dockerfile.worker"), "FROM python:3\n");
  writeFileSync(join(root, "node_modules", "ignored", "bad.ts"), 'import "@aws-sdk/client-ec2";\n');

  const report = discoverProject(join(root, "services", "python"));
  assert.equal(report.root, realpathSync(root));
  assert.deepEqual(report.terraform, [{
    path: "infra",
    files: ["infra/main.tf", "infra/outputs.tf.json"],
    variable_files: ["infra/dev.tfvars"]
  }]);
  assert.deepEqual(report.dockerfiles, [
    { path: "Dockerfile", context: "." },
    { path: "services/python/Dockerfile.worker", context: "services/python" }
  ]);
  assert.ok(report.sdk.some((entry) => entry.language === "node" && entry.package === "@aws-sdk/client-s3"));
  assert.ok(report.sdk.some((entry) => entry.language === "python" && entry.package === "boto3"));
  assert.ok(report.sdk.some((entry) => entry.language === "go" && entry.package.startsWith("github.com/aws/aws-sdk-go-v2")));
  assert.ok(report.sdk.some((entry) => entry.language === "java" && entry.package.startsWith("software.amazon.awssdk")));
  assert.equal(report.sdk.some((entry) => entry.package.includes("ec2")), false);
});

test("Terraform discovery keeps root and nested variable files project-relative", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "anbo-terraform-root-discovery-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  mkdirSync(join(root, "vars"));
  writeFileSync(join(root, "main.tf"), 'resource "aws_s3_bucket" "assets" {}\n');
  writeFileSync(join(root, "terraform.tfvars"), 'stage = "local"\n');
  writeFileSync(join(root, "vars", "development.tfvars.json"), '{"stage":"development"}\n');

  const terraform = discoverTerraform(root);
  assert.deepEqual(terraform, [{
    path: ".",
    files: ["main.tf"],
    variable_files: ["terraform.tfvars", "vars/development.tfvars.json"]
  }]);
  assert.deepEqual(createDefaultManifest({ root, terraform, sdk: [], dockerfiles: [] }).terraform, {
    roots: ["."],
    variable_files: ["terraform.tfvars", "vars/development.tfvars.json"]
  });
});

test("Terraform discovery excludes referenced nested local modules as roots", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "anbo-terraform-module-discovery-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  mkdirSync(join(root, "infra", "modules", "queue"), { recursive: true });
  mkdirSync(join(root, "infra", "modules", "queue", "nested"), { recursive: true });
  mkdirSync(join(root, "infra", "modules", "topic"), { recursive: true });
  mkdirSync(join(root, "infra", "vars"), { recursive: true });
  writeFileSync(join(root, "infra", "main.tf"), [
    'module "queue" {',
    '  source = "./modules/queue"',
    '}',
    '# module "ignored" { source = "./not-a-module" }'
  ].join("\n"));
  writeFileSync(join(root, "infra", "modules.tf.json"), JSON.stringify({
    module: { topic: { source: "./modules/topic" } }
  }));
  writeFileSync(join(root, "infra", "modules", "queue", "main.tf"), 'resource "aws_sqs_queue" "this" {}\n');
  writeFileSync(join(root, "infra", "modules", "queue", "nested", "main.tf"), 'resource "aws_sqs_queue_policy" "this" {}\n');
  writeFileSync(join(root, "infra", "modules", "topic", "main.tf"), 'resource "aws_sns_topic" "this" {}\n');
  writeFileSync(join(root, "infra", "modules", "queue", "fixture.tfvars"), 'name = "fixture"\n');
  writeFileSync(join(root, "infra", "vars", "development.tfvars"), 'stage = "development"\n');

  assert.deepEqual(discoverTerraform(root), [{
    path: "infra",
    files: ["infra/main.tf", "infra/modules.tf.json"],
    variable_files: ["infra/vars/development.tfvars"]
  }]);
});

test("Terraform discovery keeps sibling independent roots and their variable files separate", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "anbo-terraform-multi-root-discovery-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  mkdirSync(join(root, "stacks", "api", "config"), { recursive: true });
  mkdirSync(join(root, "stacks", "worker"), { recursive: true });
  writeFileSync(join(root, "stacks", "api", "main.tf"), 'resource "aws_apigatewayv2_api" "this" {}\n');
  writeFileSync(join(root, "stacks", "api", "config", "local.tfvars"), 'stage = "local"\n');
  writeFileSync(join(root, "stacks", "worker", "main.tf.json"), '{"resource":{}}\n');
  writeFileSync(join(root, "stacks", "worker", "worker.tfvars"), 'stage = "local"\n');

  assert.deepEqual(discoverTerraform(root), [
    {
      path: "stacks/api",
      files: ["stacks/api/main.tf"],
      variable_files: ["stacks/api/config/local.tfvars"]
    },
    {
      path: "stacks/worker",
      files: ["stacks/worker/main.tf.json"],
      variable_files: ["stacks/worker/worker.tfvars"]
    }
  ]);
});

test("Terraform variable files route only to their deepest configured root", () => {
  const routed = routeTerraformVariableFiles(
    "/project",
    [".", "stacks/api", "stacks/worker"],
    ["stacks/worker/config/local.tfvars", "shared.tfvars", "stacks/api/api.tfvars"],
  );
  assert.deepEqual([...routed], [
    [".", ["shared.tfvars"]],
    ["stacks/api", ["api.tfvars"]],
    ["stacks/worker", ["config/local.tfvars"]]
  ]);
  assert.throws(
    () => routeTerraformVariableFiles("/project", ["stacks/api"], ["shared.tfvars"]),
    /not inside any configured Terraform root/,
  );
});

test("SDK discovery ignores transitive lock entries and keeps one best evidence file", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "anbo-sdk-discovery-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  mkdirSync(join(root, "packages", "worker", "src"), { recursive: true });

  const rootManifest = join(root, "package.json");
  const nestedManifest = join(root, "packages", "worker", "package.json");
  const source = join(root, "packages", "worker", "src", "worker.ts");
  const lock = join(root, "package-lock.json");
  writeFileSync(rootManifest, JSON.stringify({
    dependencies: { "@aws-sdk/client-s3": "3.0.0" },
    devDependencies: { "aws-sdk": "2.0.0" }
  }));
  writeFileSync(nestedManifest, JSON.stringify({ dependencies: { "@aws-sdk/client-s3": "3.0.0" } }));
  writeFileSync(source, [
    'import { S3Client } from "@aws-sdk/client-s3";',
    'import { SQSClient } from "@aws-sdk/client-sqs";'
  ].join("\n"));
  writeFileSync(lock, JSON.stringify({
    packages: {
      "node_modules/@aws-sdk/client-dynamodb": { version: "3.0.0" },
      "node_modules/@aws-sdk/client-ec2": { version: "3.0.0" }
    }
  }));

  const files = [source, nestedManifest, lock, rootManifest];
  const hints = discoverSdks(root, files);
  assert.deepEqual(discoverSdks(root, [...files].reverse()), hints);
  assert.deepEqual(hints, [
    { language: "node", package: "@aws-sdk/client-s3", file: "package.json" },
    { language: "node", package: "@aws-sdk/client-sqs", file: "packages/worker/src/worker.ts" },
    { language: "node", package: "aws-sdk", file: "package.json" }
  ]);
});

test("published JSON schema is valid JSON and pins schema version 2", () => {
  const schema = JSON.parse(readFileSync(new URL("../schemas/sandbox.v2.schema.json", import.meta.url), "utf8")) as Record<string, unknown>;
  assert.equal((schema["properties"] as Record<string, Record<string, unknown>>)["schema_version"]?.["const"], 2);
});

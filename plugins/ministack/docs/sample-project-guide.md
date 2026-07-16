# Build a Sample Project with Anbo

This guide takes a new application from ordinary AWS Terraform to a running
MiniStack sandbox with a healthy application container and a passing smoke
test. The workflow is intentionally CLI-only: deploy, inspect, test, debug, and
clean up through `anbo` rather than invoking Terraform, Docker, or a smoke script
directly.

## What You Are Building

A good first sample is a small notes application with:

- an API packaged as a Docker image;
- a DynamoDB table, SQS queue, and S3 bucket declared in Terraform;
- a health endpoint at `/healthz`;
- a smoke test that creates and reads a note;
- optional PostgreSQL and DynamoDB data clones added after the local path works.

Start with one request path and a few AWS resources. Prove that path end to end,
then add more services. A large Terraform declaration is not useful until a
smoke test demonstrates what actually works.

At the end, this command should perform all setup and acceptance work:

```bash
anbo deploy --target ministack --output jsonl
```

## 1. Install the CLI

Install the one canonical CLI and this target plugin in the sample project:

```bash
npm install --save-dev --save-exact anbo@0.2.0 @getanbo/plugin-ministack@0.1.0
npx anbo --version
```

You also need Node.js 22 or newer and a running Docker Engine or Docker Desktop
with Buildx enabled. Terraform itself does not need to be installed on the
host.

## 2. Lay Out the Project

Use one application root for discovery, the manifest, builds, and commands:

```text
notes-demo/
|-- .anbo/
|   `-- sandbox.json
|-- infra/
|   `-- main.tf
|-- src/
|   `-- server.mjs
|-- scripts/
|   `-- smoke.mjs
|-- Dockerfile
|-- package.json
`-- package-lock.json
```

Run every Anbo command from `notes-demo`, or pass `--root /path/to/notes-demo`.
Paths in `.anbo/sandbox.json` are relative to that project root.

## 3. Write Ordinary AWS Terraform

Do not add MiniStack endpoints, local credentials, or a production backend to
the Terraform. Anbo supplies the local AWS provider override and private local
state at runtime.

A useful starting `infra/main.tf` is:

```hcl
terraform {
  required_version = ">= 1.6.0, < 2.0.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = ">= 5.0, < 6.0"
    }
  }
}

provider "aws" {
  region = "us-east-1"
}

resource "aws_dynamodb_table" "notes" {
  name         = "notes-demo-notes"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "id"

  attribute {
    name = "id"
    type = "S"
  }
}

resource "aws_sqs_queue" "events" {
  name = "notes-demo-events"
}

resource "aws_s3_bucket" "attachments" {
  bucket = "notes-demo-attachments"
}

output "notes_table" {
  value = aws_dynamodb_table.notes.name
}

output "events_queue_name" {
  value = aws_sqs_queue.events.name
}

output "attachments_bucket" {
  value = aws_s3_bucket.attachments.bucket
}
```

MiniStack supports AWS provider v5 and v6, but v5 is the conservative starting
point for a sample that will grow across many services. Widen the constraint
only after the affected resources pass your smoke suite.

Terraform outputs are the contract between infrastructure and the application.
Anbo injects each non-sensitive output as
`ANBO_TERRAFORM_OUTPUT_<UPPER_SNAKE_NAME>` and lets the manifest reference it as
`${terraform.output_name}`. Terraform's `sensitive` metadata is authoritative:
only outputs explicitly marked non-sensitive are retained for later `status`,
`test`, and `run` commands, regardless of words such as `secret` in an output's
name. Sensitive outputs and outputs missing sensitivity metadata are never
persisted.

Prefer portable identifiers such as table, queue, function, and bucket names in
that contract. Some emulated Terraform URL outputs contain a host-side
`localhost` address that is not directly usable inside an application
container; resolve those resources with the injected MiniStack endpoint instead.

Anbo intentionally rejects provider credentials and endpoints, provisioners,
the `external` data source, `terraform_remote_state`, non-AWS providers, and
local modules outside the configured Terraform root. Keep sibling modules under
a common configured root.

Before choosing a service, inspect the machine-readable fidelity report:

```bash
anbo capabilities --output json
```

The report is not an allowlist. Terraform may attempt any `hashicorp/aws`
resource, but its behavior is limited by the pinned MiniStack implementation.
For example, an EC2 resource can have a working control plane without creating
a real virtual machine.

## 4. Discover the Project

Preview discovery before writing anything:

```bash
anbo configure --dry-run --output json
```

Confirm that `terraform_roots` contains `infra`, and review the Dockerfile and
SDK hints. Then write the manifest:

```bash
anbo configure --output json
```

`configure` only discovers and writes `.anbo/sandbox.json`. It never edits your
Terraform or application source. If a manifest already exists, edit it rather
than using `--force` unless you explicitly want to regenerate it. To preview
fresh discovery without overwriting an existing manifest, use:

```bash
anbo configure --force --dry-run --output json
```

## 5. Package the Application

The application must listen on `0.0.0.0` inside its container. It receives:

- `AWS_ENDPOINT_URL` and `ANBO_MINISTACK_ENDPOINT`;
- local AWS credentials and `AWS_REGION`;
- every safe Terraform output as `ANBO_TERRAFORM_OUTPUT_*`;
- the checkout-isolated runtime identity as `ANBO_PROJECT_ID`;
- the current operation ID as `ANBO_RUN_ID`;
- any environment bindings declared in the manifest.

Use `ANBO_MINISTACK_ENDPOINT` explicitly for SDKs that do not honor
`AWS_ENDPOINT_URL`. Never hard-code `localhost:4566` in container code because
`localhost` there is the application container, not MiniStack.
Configure S3 clients for path-style addressing when their SDK does not infer it
from the local endpoint.

The Docker image must also contain its smoke script because configured tests run
inside the selected service container. For example:

```dockerfile
FROM node:22-alpine

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY scripts ./scripts

USER node
CMD ["node", "src/server.mjs"]
```

Add a `/healthz` endpoint that returns success only when the process is ready to
serve. Keep startup migrations or seed validation visible in the service logs.

## 6. Define Builds, Services, and Tests

After `configure`, make `.anbo/sandbox.json` look like this minimal complete
manifest. Keep the generated MiniStack tag and digest unchanged.

```json
{
  "$schema": "https://raw.githubusercontent.com/getanbo/anbo-cli/main/plugins/ministack/schemas/sandbox.v2.schema.json",
  "schema_version": 2,
  "project": {
    "name": "notes-demo"
  },
  "terraform": {
    "roots": ["infra"],
    "variable_files": []
  },
  "data": {},
  "builds": {
    "api": {
      "context": ".",
      "dockerfile": "Dockerfile"
    }
  },
  "services": {
    "api": {
      "build": "api",
      "environment": {
        "NOTES_TABLE": "${terraform.notes_table}",
        "EVENTS_QUEUE_NAME": "${terraform.events_queue_name}",
        "ATTACHMENTS_BUCKET": "${terraform.attachments_bucket}"
      },
      "ports": [
        {
          "container": 8080,
          "protocol": "tcp"
        }
      ],
      "healthcheck": {
        "type": "command",
        "command": [
          "node",
          "-e",
          "fetch('http://127.0.0.1:8080/healthz').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
        ],
        "timeout_seconds": 30,
        "interval_seconds": 1
      },
      "dynamodb_plane": "ministack"
    }
  },
  "tests": {
    "notes-smoke": {
      "command": ["node", "scripts/smoke.mjs"],
      "service": "api",
      "depends_on": ["api"],
      "timeout_seconds": 60,
      "default": true,
      "environment": {
        "ANBO_TEST_PROTOCOL": "jsonl-v1"
      }
    }
  },
  "ministack": {
    "image": "ghcr.io/getanbo/anbo-ministack@sha256:cf29ce9cacd3982531b5f5bd48a7b46c10acaf4f44a10fb25831b3073c26b204",
    "digest": "sha256:cf29ce9cacd3982531b5f5bd48a7b46c10acaf4f44a10fb25831b3073c26b204",
    "profile": "full",
    "persistence": true
  },
  "network": {
    "allow_hosts": [],
    "clone_egress": false
  },
  "adapters": {}
}
```

Docker build invalidation follows the complete effective context after
`.dockerignore` filtering. Keep `.dockerignore` narrow and complete; `inputs`
applies only to command builds. Anbo reuses a Docker image only when the
fingerprint matches and the image still exists.

Omit `host` from a port to let Docker allocate a free loopback port. Read the
actual address from the terminal deploy summary or `anbo status`; do not assume
that it is port 8080 on the host.

## 7. Write an Agent-Friendly Smoke Test

A smoke test should exercise one complete user action, assert its side effects,
and fail with a non-zero exit code. It must use values injected by Anbo and must
not start its own infrastructure.

With `ANBO_TEST_PROTOCOL=jsonl-v1`, write one JSON object per line using these
event kinds:

- `test.started`
- `test.progress`
- `test.assertion`
- `test.finished`

Every line should carry the injected run and correlation IDs. A small helper
looks like this:

```js
import assert from "node:assert/strict";

const runId = required("ANBO_RUN_ID");
const correlationId = required("ANBO_TEST_RUN_ID");
const endpoint = "http://127.0.0.1:8080";

emit("test.started", { name: "notes-smoke" });

const id = `note-${runId}`;
const created = await fetch(`${endpoint}/notes`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ id, title: "CLI smoke" })
});
assert.equal(created.status, 201);
emit("test.assertion", { name: "note.create", status: "passed" });

const loaded = await fetch(`${endpoint}/notes/${encodeURIComponent(id)}`);
assert.equal(loaded.status, 200);
assert.equal((await loaded.json()).title, "CLI smoke");
emit("test.assertion", { name: "note.read", status: "passed" });
emit("test.finished", { name: "notes-smoke", status: "passed" });

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required; run this test through anbo`);
  return value;
}

function emit(kind, fields) {
  process.stdout.write(`${JSON.stringify({
    schema_version: 1,
    kind,
    ...fields,
    run_id: runId,
    correlation_id: correlationId
  })}\n`);
}
```

Anbo retains the original stdout and also promotes valid child records into the
top-level event stream. Use unique test data derived from `ANBO_RUN_ID` so an
assertion cannot accidentally pass on stale state.

## 8. Bring Up the First Sandbox

First isolate infrastructure, build, and health-check failures from test
failures:

```bash
anbo deploy --no-test --output jsonl
```

The last record must be `run.finished` with `status: "succeeded"`. Its summary
contains the MiniStack host endpoint, published service ports, Terraform
outputs, build fingerprints, and cache-hit status.

Now run the configured test through the existing sandbox:

```bash
anbo test notes-smoke --output jsonl
```

Once both pass, use the single-command path that agents and CI should rely on:

```bash
anbo sandbox up --output jsonl
```

Never substitute these commands with `terraform apply`, `docker run`, or
`node scripts/smoke.mjs`. That would bypass endpoint routing, clone injection,
redaction, caching, locks, structured feedback, and the exact product path you
need to validate.

Run IDs are unique and host-owned. Read the `runId` on `run.started` or
`run.finished` and retain the JSONL stream so an agent can call `debug` on the
exact failed run. User-supplied run IDs are not accepted as correlation IDs.
There is no ignored `--timeout` shortcut: configure test deadlines with each
manifest test's `timeout_seconds`, and let the caller impose a whole-command
deadline when orchestration requires one.

## 9. Add Cloud Data Clones

Add clones only after the local MiniStack path passes. Clone declarations and
secret references belong in `.anbo/sandbox.json`, not Terraform. Resolved
endpoints and credentials stay in environment variables or secret commands.

For already-created clone URLs:

```json
{
  "data": {
    "postgres": {
      "provider": "external",
      "endpoint": "env://NOTES_DATABASE_URL",
      "retain_on_down": true
    },
    "dynamodb": {
      "provider": "external",
      "endpoint": "env://NOTES_DYNAMODB_CLONE_ENDPOINT",
      "region": "us-east-1",
      "credentials": {
        "access_key_id": "env://NOTES_DYNAMODB_CLONE_ACCESS_KEY_ID",
        "secret_access_key": "env://NOTES_DYNAMODB_CLONE_SECRET_ACCESS_KEY",
        "session_token": "env://NOTES_DYNAMODB_CLONE_SESSION_TOKEN"
      },
      "retain_on_down": true
    }
  }
}
```

Export the referenced values only in the process that launches Anbo:

```bash
export NOTES_DATABASE_URL='postgresql://user:password@pg-clone.example.com:5432/notes?sslmode=require'
export NOTES_DYNAMODB_CLONE_ENDPOINT='https://ddb-clone.example.com'
export NOTES_DYNAMODB_CLONE_ACCESS_KEY_ID='...'
export NOTES_DYNAMODB_CLONE_SECRET_ACCESS_KEY='...'
export NOTES_DYNAMODB_CLONE_SESSION_TOKEN='...'
```

Remove the `session_token` reference from the manifest when the cloning service
does not issue one. Access key ID and secret access key remain required.

Remote PostgreSQL requires `sslmode=require`, `verify-ca`, or `verify-full`.
Remote DynamoDB requires HTTPS. Secret fields accept only `env://` or `exec://`
references and are never passed into Terraform or persisted in Anbo state.

A Docker service receives PostgreSQL by explicitly binding it:

```json
{
  "environment": {
    "DATABASE_URL": "${clone.postgres.database_url}"
  }
}
```

Set `dynamodb_plane` to `clone` when cloned DynamoDB should be that service's
default AWS data plane. Keep it as `ministack` for locally-created Terraform
tables. Code that needs both must create two clients and use the explicit
`ANBO_DYNAMODB_CLONE_*` settings for the cloned client.

A MiniStack Lambda opts into post-Terraform clone injection with a non-secret
marker in its Terraform environment:

```hcl
environment {
  variables = {
    ANBO_CLONE_REQUIRED = "postgres,dynamodb"
  }
}
```

The Lambda then receives `ANBO_POSTGRES_URL` and
`ANBO_DYNAMODB_CLONE_*`. The actual values never enter the Terraform plan or
state.

For clones created by your cloud cloning service, use `provider: "anbo-cloud"`
with a `source` alias and export `ANBO_API_URL` and `ANBO_TOKEN`. See
[Data Clones](../README.md#data-clones) for the complete form.

## 10. Use the Development Loop

Deploy after source or Terraform changes:

```bash
anbo deploy --output jsonl
```

Unchanged command builds and Docker images are reused. A normal deploy starts no
Terraform workers only when the owned inputs, saved state metadata, filtered
outputs, and exact MiniStack process generation match the last ready deploy.
Always confirm the reported reconciliation and cache results rather than
inferring them from elapsed time.

Request an explicit drift refresh when needed:

```bash
anbo deploy --reconcile --output jsonl
```

Reconciliation still runs init, validation, and plan, but a no-change plan does
not run apply. If the project commits `.terraform.lock.hcl`, the plugin keeps a
private, project-scoped cache of worker-platform checksum augmentation. The
source lock remains unchanged, and lockless projects do not reuse that cache.

Use these commands instead of dropping below the CLI:

```bash
anbo status --output json
anbo test notes-smoke --output jsonl
anbo logs --follow --service api --output jsonl
anbo run --output jsonl -- node -e "console.log(process.env.ANBO_MINISTACK_ENDPOINT)"
anbo cache inspect --output json
```

`anbo run` executes in the first declared running service. Use it for a focused
inspection, not as a replacement for a checked-in smoke suite.
`logs --follow` has no deadline option; stop it with an interrupt when enough
evidence has been collected.

If a run fails, retain its JSONL and use the host-issued run ID:

```bash
anbo deploy --output jsonl >anbo-deploy.jsonl
RUN_ID=$(jq -r 'select(.type == "run.started") | .runId' anbo-deploy.jsonl)
anbo debug "$RUN_ID" --output json
```

Read the stable `ANBO_*` diagnostic code, cause, evidence, remediation, and
retry guidance. Common exit codes are:

| Exit | Meaning |
| ---: | --- |
| 3 | Docker or another prerequisite is unavailable. |
| 4 | The manifest or project configuration is invalid. |
| 5 | A clone could not be acquired, validated, or reached. |
| 6 | Terraform validation, plan, or apply failed. |
| 7 | MiniStack or an application service failed. |
| 8 | A configured smoke test failed. |
| 10 | Another operation holds the project lock. |
| 124 | The operation exceeded its deadline. |

## 11. Reset and Clean Up

`down` stops managed containers but keeps reusable local state:

```bash
anbo down --output jsonl
```

Reset MiniStack and private Terraform state, then deploy again:

```bash
anbo reset --output jsonl
```

Remove the project's local state and MiniStack volume:

```bash
anbo down --purge --output jsonl
```

External clones are never deleted by Anbo. `--purge-clones` applies only to
owned Anbo Cloud branches and must be requested explicitly.

## 12. Definition of Done

Treat the sample as complete when all of these are true:

- `configure --dry-run` discovers the intended Terraform root, Dockerfile, and
  SDKs.
- `deploy --no-test` provisions Terraform and reaches every service health
  check.
- `anbo test` verifies a current-run user action and its important side effects.
- `anbo sandbox up` repeats the full path with one command.
- A second unchanged deploy reports build cache hits and skips unchanged
  Terraform roots without starting workers.
- `logs --follow` carries the active `ANBO_RUN_ID` through application logs.
- An intentional failure produces a useful `debug` response with no secrets.
- No test or benchmark invokes Terraform, Docker, or the smoke script outside
  the Anbo CLI.

For integrations MiniStack does not provide, add a protocol v2 adapter instead
of modifying the core CLI. See [Adapter Protocol v2](adapters-v2.md).

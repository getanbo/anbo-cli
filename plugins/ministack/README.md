# Anbo MiniStack Plugin

`@getanbo/plugin-ministack` adds the `ministack` deployment target to the
canonical [`anbo`](https://github.com/getanbo/anbo-cli) CLI. It discovers Terraform
without AI, starts a digest-pinned MiniStack runtime, applies isolated AWS
Terraform, attaches optional PostgreSQL and DynamoDB clones, runs declared
services and smoke tests, and streams typed events back through the CLI.

This package deliberately has no executable. Install and invoke only `anbo`.

## Install

For a machine-wide agent toolchain with a direct `anbo` executable:

```bash
npm install --global anbo@0.2.0 @getanbo/plugin-ministack@0.1.0
```

For a project-pinned toolchain that is reproducible in CI:

```bash
npm install --save-dev --save-exact anbo@0.2.0 @getanbo/plugin-ministack@0.1.0
```

Add `.anbo/project.json`:

```json
{
  "apiVersion": "anbo.dev/project/v1",
  "defaultTarget": "ministack",
  "plugins": {
    "ministack": {
      "package": "@getanbo/plugin-ministack",
      "config": { "manifest": ".anbo/sandbox.json" }
    }
  }
}
```

Then use the installed CLI from the project root:

```bash
npx anbo configure --target ministack --output jsonl
npx anbo impact --target ministack --output json
npx anbo deploy --target ministack --output jsonl
npx anbo status --target ministack --output jsonl
npx anbo test --target ministack --affected --output jsonl
npx anbo verify --target ministack --full --output jsonl
npx anbo logs --target ministack --follow --output jsonl
npx anbo debug --target ministack --output jsonl
npx anbo recover --target ministack --stale --output jsonl
npx anbo down --target ministack --purge --output jsonl
```

`anbo sandbox up` remains a canonical CLI compatibility alias for deploying the
default MiniStack target. New automation should use `anbo deploy`.

## What Configure Discovers

`configure` walks the project deterministically and writes
`.anbo/sandbox.json`. It discovers:

- independent Terraform roots and their nearest `.tfvars` files;
- AWS SDK usage in Node.js, Python, Go, and Java source and manifests;
- Dockerfiles and project-relative build contexts.

It does not modify application code, call an AI model, or infer secrets.
If configuration happened before Terraform or Dockerfiles existed, the first
deploy replaces only the generated empty-project placeholder. Run
`anbo configure --target ministack --refresh` to merge later-discovered roots
and builds while preserving configured services, tests, clones, and adapters.

## Data Clones

Clone values are resolved at execution time and never enter Terraform plans or
state. An externally managed PostgreSQL clone can be supplied as a URL:

```json
{
  "data": {
    "postgres": {
      "provider": "external",
      "endpoint": "env://ANBO_POSTGRES_CLONE_URL",
      "retain_on_down": true
    }
  }
}
```

An externally managed DynamoDB clone uses an endpoint and short-lived
credentials:

```json
{
  "data": {
    "dynamodb": {
      "provider": "external",
      "endpoint": "env://ANBO_DYNAMODB_CLONE_ENDPOINT",
      "region": "us-east-1",
      "credentials": {
        "access_key_id": "env://ANBO_DYNAMODB_ACCESS_KEY_ID",
        "secret_access_key": "env://ANBO_DYNAMODB_SECRET_ACCESS_KEY",
        "session_token": "env://ANBO_DYNAMODB_SESSION_TOKEN"
      }
    }
  }
}
```

`provider: "anbo-cloud"` instead requests and reuses clone leases from
`ANBO_API_URL` with `env://ANBO_TOKEN`. The host secret resolver handles both
`env://` and `exec://` references.

## Builds And Tests

Build fingerprints cover declared configuration. Command builds honor declared
inputs; Docker context fingerprints cover the complete context after
`.dockerignore` filtering (including Dockerfile-specific ignore files) and
include entry type, symbolic-link target, and permission mode. A matching local
artifact is reused rather than rebuilt. Terraform provider plugins, private
workspaces, Docker BuildKit cache, MiniStack persistence, and clone metadata are
stored under the CLI-provided namespaced state and cache paths.

Terraform source fingerprints remain content-based, but the plugin keeps a
private per-project, per-root digest cache outside the source tree. An unchanged
warm deploy reads file metadata without rereading every file body; a metadata
change rehashes only that file, and a touch with identical bytes does not change
the reconciliation fingerprint. Cache files are replaced atomically with private
permissions, and a missing or malformed cache falls back to a full content scan.

MiniStack startup, clone acquisition, and declared image builds run concurrently.
Cancellable readiness, build, and runtime work stops on the first real failure;
an in-flight cloud clone create is allowed to return just long enough to persist
branch ownership before its remaining readiness work is cancelled. Docker Buildx is used when
available; otherwise the plugin falls back to the classic Docker builder rather
than failing setup. The plugin reads the Docker server platform and selects its
native amd64 or arm64 image from the certified, digest-pinned multi-platform
index. Both the selected and reported platforms are recorded in structured
phase output. On certified ARM64 Docker servers, the plugin injects the pinned
`OPENSSL_armcap=0` compatibility setting required by MiniStack 1.4.2 under
virtualized ARM CPUs. It certifies native architecture, Ed25519, AsyncSSH, the
full health profile, KMS, strict Docker Lambda execution, and a
Lambda-to-MiniStack callback before returning ready, then reuses a
recipe-fingerprinted Docker-local certification tag on warm deploys. AMD64 does
not receive this setting. Strict mode prevents a broken Docker-in-Docker setup
from being hidden by MiniStack's local subprocess fallback.

A normal deploy skips a Terraform root only when its owned inputs, saved state
metadata, filtered outputs, and the exact healthy MiniStack container process
match the last ready deploy. Use `anbo deploy --reconcile` for an explicit drift
refresh. Every reconciled root still runs init, validation, and plan, but a
no-change plan never runs apply. When a source lock file exists, the plugin
privately caches init-augmented provider checksums by project, root, source lock,
and worker identity; it never modifies the source lock or invents one for a
lockless project.

Each reconciled Terraform root uses one short-lived worker container for init,
validate, plan, show, apply, and output. The worker has normal egress only for
provider initialization, then moves to the isolated MiniStack control network;
apply still consumes the exact saved plan. Unchanged, healthy application
containers are reused. A changed service restarts only its dependent branch,
and test-only runs reuse runtime-bound services when their resolved bindings are
unchanged.

Smoke tests are declared in `.anbo/sandbox.json` and execute only through
`anbo test` or the deploy lifecycle. Tests may emit the `jsonl-v1` protocol;
the plugin promotes assertions and progress into the canonical ordered event
stream while retaining process output for debugging.

Deploys use a content-fingerprinted dependency graph. An unchanged running
sandbox skips build, Terraform, service, and test phases when its persisted
runtime and build artifacts remain valid and no test policy or previous failure
selects work. A selected or test-only change can skip build, Terraform, and
service reconciliation when no clone, adapter, or runtime-bound service needs a
binding refresh; otherwise the existing content-addressed build, per-root
Terraform, and service reconcilers run. Affected default-policy tests run
afterward. Preview decisions with `anbo impact`; choose
`anbo deploy --verify affected|full|none`, focused
`anbo test --affected|--failed|--all`, or `anbo verify --full` as the confidence
level requires. Test entries can declare project-relative `inputs`, namespaced
`requires`, `tags`, `cache`, and `always_run`. Unknown adapter inputs and
invalid ledger state fall back conservatively rather than creating a false
cache hit; an unknown required node is a configuration error. The private
ledger and full-verification attestations live in the plugin's `.anbo/state`
namespace. See [Selective execution](docs/selective-execution.md).

Failures return one canonical diagnostic with a stable code, exact exit code,
phase, retryability, remediation, and any safe evidence. `anbo logs` and
`anbo debug` can inspect labelled containers even when startup never reached a
ready state; debug output includes bounded, redacted container state and log
tails for the failed run.

## MiniStack Coverage

The capability matrix currently describes 71 MiniStack service surfaces across
real, emulated, conditional, control-plane-only, and bring-your-own data planes.
Run the CLI for the machine-readable matrix:

```bash
npx anbo capabilities --target ministack --output json
```

Terraform is limited to `hashicorp/aws` in a digest-pinned worker. The plugin
rejects production AWS credentials, provisioners, external data sources,
remote-state data sources, host Terraform fallback, and local modules that
escape the configured root. See [MiniStack support](docs/ministack-support.md).

Each checkout receives a root-derived runtime ID. The certified Anbo MiniStack
runtime uses that ID to scope child-container names, persistent volumes,
dynamic host ports, ownership labels, and lifecycle cleanup. Multiple checkouts
can therefore share one Docker daemon while keeping their MiniStack parents and
Docker-backed Lambda, RDS, ECS, EKS, ElastiCache, OpenSearch, MWAA, and Glue
children independent. Startup fails before Terraform runs if an image does not
expose the required instance-isolation health contract.

## Extensions

Protocol v2 adapters cover project-specific integrations missing from the
target. Adapters are explicit, optionally digest-pinned trusted executables and
return typed bindings and diagnostics. See [Adapter protocol v2](docs/adapters-v2.md).

## Runtime Pin

[`runtime-manifest.json`](runtime-manifest.json) is the single audited runtime
pin. It records the Anbo MiniStack release and commit, its exact upstream
MiniStack provenance, the immutable full-image index, every certified platform,
the instance-isolation contract, and the ARM64 compatibility recipe. Mutable
tags are never accepted as the release pin.

## Development

```bash
npm ci
# Install a packed @getanbo/plugin-sdk 0.2 artifact for type checking.
npm run verify
```

Unit tests may exercise runtime components directly. Integration, smoke, and
release qualification must pack both packages, install them in an empty prefix,
and invoke only `node_modules/.bin/anbo`. `scripts/run-installed-cli-acceptance.mjs`
enforces that boundary when `ANBO_CLI_TARBALL` is provided.

## License

MIT. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for separately
distributed runtime components.

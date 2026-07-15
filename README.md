# Anbo MiniStack Plugin

`@getanbo/plugin-ministack` adds the `ministack` deployment target to the
canonical [`anbo`](https://github.com/getanbo/cli) CLI. It discovers Terraform
without AI, starts a digest-pinned MiniStack runtime, applies isolated AWS
Terraform, attaches optional PostgreSQL and DynamoDB clones, runs declared
services and smoke tests, and streams typed events back through the CLI.

This package deliberately has no executable. Install and invoke only `anbo`.

## Install

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
npx anbo deploy --target ministack --output jsonl
npx anbo status --target ministack --output jsonl
npx anbo test --target ministack --output jsonl
npx anbo logs --target ministack --follow --output jsonl
npx anbo debug --target ministack --output jsonl
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

Build fingerprints cover declared configuration and inputs. A matching local
artifact is reused rather than rebuilt. Terraform provider plugins, private
workspaces, Docker BuildKit cache, MiniStack persistence, and clone metadata are
stored under the CLI-provided namespaced state and cache paths.

Smoke tests are declared in `.anbo/sandbox.json` and execute only through
`anbo test` or the deploy lifecycle. Tests may emit the `jsonl-v1` protocol;
the plugin promotes assertions and progress into the canonical ordered event
stream while retaining process output for debugging.

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

## Extensions

Protocol v2 adapters cover project-specific integrations missing from the
target. Adapters are explicit, optionally digest-pinned trusted executables and
return typed bindings and diagnostics. See [Adapter protocol v2](docs/adapters-v2.md).

## Runtime Pin

[`runtime-manifest.json`](runtime-manifest.json) is the single audited runtime
pin. The initial source is marked `upstream-bootstrap` and uses the certified
MiniStack v1.4.2 full-image digest. It must be replaced by an immutable
`ghcr.io/getanbo/anbo-ministack@sha256:...` index digest after the first Anbo
MiniStack candidate passes the installed-CLI acceptance suite. Mutable tags are
never accepted as the release pin.

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

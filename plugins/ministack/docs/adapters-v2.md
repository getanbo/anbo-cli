# Adapter Protocol v2

Adapters extend Anbo when MiniStack, clone providers, or the built-in service
runtime do not expose a needed integration. An adapter is a trusted executable
that receives one JSON request on stdin and returns one JSON response on stdout.
It must use protocol version 2.

## Manifest Entry

```json
{
  "adapters": {
    "payments": {
      "executable": "tools/anbo-payments-adapter",
      "protocol": 2,
      "digest": "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      "args": ["--mode", "sandbox"],
      "capabilities": ["payments.checkout", "impact.graph.v1"],
      "environment": {
        "PAYMENTS_TOKEN": "env://PAYMENTS_TOKEN"
      },
      "allowed_hosts": ["payments-sandbox.example.com"]
    }
  }
}
```

The executable must be a PATH command or project-relative path; absolute paths
are rejected. A digest is strongly recommended and requires an explicit
project-relative path. Adapter environment values must be `env://` or
`exec://` secret references. The process receives only `PATH`, `HOME`, `TMPDIR`,
`ANBO_ADAPTER_PROTOCOL=2`, and its declared environment.

`allowed_hosts` is descriptive in this MVP and is not enforced by a firewall.
Adapters run as local host processes, can read the project root passed in the
request, and are inside the host trust boundary. Install only adapters you
trust, prefer a digest, and do not treat environment filtering as a sandbox.

## Request

```json
{
  "schema_version": 2,
  "action": "acquire",
  "project_id": "notes",
  "project_root": "/absolute/path/to/notes",
  "run_id": "run_123",
  "payload": {
    "ministack_endpoint": "http://127.0.0.1:4566",
    "terraform_outputs": {},
    "clone_engines": ["postgres"]
  }
}
```

The current CLI invokes these actions:

| CLI operation | Adapter actions |
| --- | --- |
| Impact planning | `impact` only for adapters declaring `impact.graph.v1` |
| Deploy with adapters | `handshake`, then `acquire`, followed by a post-reconciliation `impact` for capable adapters |
| Adapter-free warm deploy | No adapter actions; only adapter-free projects are eligible for the graph-cache-hit and tests-only fast paths |
| Test / verify | `test` with `selected_test` in the payload, then `impact` for capable adapters |
| Reset | `reset` before local infrastructure is recreated, followed by the reconciling deploy actions |
| Down | `release`, then `teardown` |

`discover`, `configure`, `renew`, and `health` names are reserved by the v2 type
contract but are not invoked by the current CLI.

## Response

```json
{
  "schema_version": 2,
  "adapter": "payments",
  "capabilities": ["payments.checkout", "impact.graph.v1"],
  "bindings": [
    {
      "name": "api",
      "kind": "http",
      "endpoint": "https://payments-sandbox.example.com",
      "secret_handle": "session-handle",
      "metadata": { "mode": "sandbox" }
    }
  ],
  "diagnostics": [
    {
      "code": "PAYMENTS_READY",
      "level": "warning",
      "message": "Using the sandbox merchant account",
      "retryable": false
    }
  ],
  "impact": {
    "nodes": [
      {
        "id": "adapter:payments",
        "kind": "adapter",
        "fingerprint": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "dependencies": [],
        "certainty": "exact",
        "cacheable": true,
        "always_run": false,
        "metadata": { "contract": "sandbox-v1" }
      }
    ]
  }
}
```

The adapter must write exactly one response object to stdout and exit zero.
Write operational logs to stderr; Anbo streams and redacts them. Stdout or
stderr over 4 MiB, invalid JSON/schema, a non-zero exit, or a 30-second timeout
fails the action. Every manifest-declared capability must appear in the
response. An error diagnostic also fails the action after its remediation is
emitted; warnings remain visible but do not fail it.

`impact` is optional unless the manifest declares `impact.graph.v1`. Contributed
node IDs use `<kind>:<name>` and may depend on runtime, build, Terraform, clone,
adapter, service, or test node IDs. A node with `certainty: "unknown"` must
include a non-empty `issues` array; Anbo selects that node and its dependent
subtree. Missing dependency IDs are configuration errors rather than an
implicit whole-graph fallback.

Binding endpoints and secret handles are registered with the run redactor.
Services can consume an acquired binding in manifest environment values:

```json
{
  "services": {
    "api": {
      "image": "example/api:local",
      "environment": {
        "PAYMENTS_ENDPOINT": "${adapter.payments.api.endpoint}",
        "PAYMENTS_SESSION": "${adapter.payments.api.secret_handle}"
      }
    }
  }
}
```

As with clone credentials, values injected into a Docker service are visible to
a local Docker administrator. Adapters should return short-lived handles rather
than durable credentials whenever possible.

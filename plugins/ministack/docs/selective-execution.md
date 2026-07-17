# Selective Execution

Anbo plans the local deployment as a dependency graph instead of treating every
deploy as a request to rebuild, reapply, and rerun everything. The graph contains
the MiniStack runtime, builds, Terraform roots, clones, adapters, services, and
tests. Each node has a content fingerprint and explicit dependency edges.

The default development loop is:

```bash
anbo impact --target ministack --output json
anbo deploy --target ministack --output jsonl
```

`impact` explains the plan without applying it. On deploy, an unchanged,
running sandbox takes a graph-cache-hit fast path only when its persisted
runtime and build artifacts are still valid and no test policy selects work.
A test-only change skips build, Terraform, and service reconciliation when the
manifest has no clones, adapters, or runtime-bound services that require a
credential or binding refresh. Other changes run the existing
content-addressed build, per-root Terraform, and service reconcilers before
affected default-policy tests are selected. A cold project has no reusable
results, so its first deploy remains conservative.

## Commands

### Preview the plan

```bash
anbo impact --target ministack --output json
```

The result identifies every graph node as `execute`, `reuse`, or `remove`. Each
decision includes a stable reason such as:

- `new_node` or `cold_run`
- `fingerprint_changed`
- `dependency_fingerprint_changed` or `dependency_selected`
- `previous_failed` or `previous_dirty`
- `unknown_inputs`
- `cache_disabled` or `always_run`
- `cache_hit`

On deploy, removed test entries are deleted from the ledger and removed service
nodes delete their managed containers. Build images and local build caches are
retained until `anbo cache prune`. Owned Anbo Cloud clone branches are retained
unless `anbo down --purge-clones` is requested; external clones are never
deleted by Anbo.

Terraform-root and adapter removals require an explicit cleanup sequence.
Removing a previously managed Terraform root is rejected until
`anbo down --purge` clears its private state. An adapter must remain declared
while `anbo down` invokes its `release` and `teardown` actions; if an adapter
entry is removed first, deploy rejects the change and tells you to restore the
entry, run `down`, and then remove it.

With `--output json`, the plan is at
`events[type="command.result"].data.plan` inside the `anbo.dev/run/v1`
envelope. With `--output jsonl`, it is at `command.result.data.plan` and also
appears in the ordered impact progress event. The plan includes graph and plan
fingerprints, execution order, dependencies, and reasons.

### Deploy affected work

```bash
anbo deploy --target ministack --output jsonl
anbo deploy --target ministack --verify affected --output jsonl
```

These commands are equivalent for verification selection. Anbo reuses matching
healthy nodes and runs affected tests whose policy is `default: true`,
`always_run: true`, or `cache: false`. Non-default cacheable tests remain
available through an explicit name or `anbo test --all`. Infrastructure that
completed successfully remains reusable if a later test fails.

Choose another verification mode explicitly when needed:

```bash
anbo deploy --target ministack --verify full --output jsonl
anbo deploy --target ministack --verify none --output jsonl
```

`full` runs every configured test after the affected deployment work. `none`
does not run tests. Use `none` only for an intentional infrastructure-only
iteration; it does not produce a full verification attestation.

### Run tests against the current sandbox

```bash
anbo test --target ministack --affected --output jsonl
anbo test --target ministack --failed --output jsonl
anbo test --target ministack --all --output jsonl
anbo test notes-smoke --target ministack --output jsonl
```

`--affected` runs tests selected by current inputs and dependency changes.
`--failed` retries tests whose most recent ledger result failed. `--all` runs
every configured test. A positional name remains the most focused explicit
rerun. Plain `anbo test` runs every test with `default: true`, independent of
the affected plan.

`anbo test --affected` and `anbo verify --full` require deployed non-test nodes
to match current inputs. If builds, Terraform, adapters, clones, or services are
stale, they return `ANBO_DEPLOY_REQUIRED`; run `anbo deploy` first.

Test failures leave the successfully deployed sandbox ready. Their structured
diagnostic includes `test_id`, service, exit code, bounded output tails, the
last decoded test event when available, and an exact `rerun` command.

### Create a full verification attestation

```bash
anbo verify --target ministack --full --output jsonl
```

Full verification forces every configured test while reusing healthy,
fingerprint-matching infrastructure. On success, Anbo records a local
content-addressed attestation for the current graph, runtime generation,
deployment inputs, and test results. Any relevant graph or input change makes
that attestation stale. A normal affected deploy is fast feedback; this command
is the deliberate release or pre-AWS confidence gate.

### Recover a stale operation lock

```bash
anbo recover --target ministack --stale --output jsonl
```

Recovery removes only a lock Anbo can prove is stale, such as a dead or zombie
owner or a reused PID. An expired heartbeat never overrides a positively
identified live process generation, so laptop sleep or a paused debugger cannot
create concurrent deploys. The command is idempotent when no stale lock exists.
Read-only commands such as `status`, `logs`, `debug`, `capabilities`, and
`impact` do not take the exclusive deployment lock.

## Declaring Test Impact

Add selective metadata to each test in `.anbo/sandbox.json`:

```json
{
  "tests": {
    "notes-smoke": {
      "command": ["node", "scripts/notes-smoke.mjs"],
      "service": "api",
      "depends_on": ["api"],
      "inputs": [
        "src/notes/**",
        "scripts/notes-smoke.mjs",
        "package.json",
        "package-lock.json"
      ],
      "requires": [
        "service:api",
        "terraform:infra"
      ],
      "tags": ["smoke", "notes"],
      "cache": true,
      "always_run": false,
      "timeout_seconds": 60,
      "default": true
    }
  }
}
```

Every test must set `service` to an existing declared service. Its command runs
inside that service container; there is no host-run test mode. `depends_on`
optionally names additional services that must be ready.

The optional selective fields are:

| Field | Meaning |
| --- | --- |
| `inputs` | Project-relative files, directories, or glob patterns whose content can affect the test. |
| `requires` | Additional graph dependencies using `runtime:`, `build:`, `terraform:`, `clone:`, `adapter:`, `service:`, or `test:` node IDs. |
| `tags` | Stable labels carried into plans and reports. Tags do not change selection by themselves. |
| `cache` | Set to `false` when a previous passing result must never be reused. Defaults to `true`. |
| `always_run` | Set to `true` for a policy check that must run on every plan, including an unchanged project. Defaults to `false`. |

`requires` adds impact edges; it does not replace the required `service` runner
or optional `depends_on` runtime dependencies.

Input patterns are relative to the project root and cannot escape it. Include
the test command, application files it exercises, and relevant dependency lock
files. Use separate test entries for independently selectable behavior. One
large opaque smoke command is still one graph node, so Anbo cannot safely run
only part of it.

## Conservative Fallback

Selection is an optimization, never a claim that Anbo can infer every hidden
dependency. Anbo runs work instead of reusing it when:

- an input cannot be read or fingerprinted deterministically;
- an adapter marks one of its contributed nodes as `certainty: "unknown"`;
- the ledger is missing, invalid, interrupted, or records a failure;
- a node disables caching or is configured to run every time.

Unknown input selection propagates through dependent nodes. This can run more
than strictly necessary, but it prevents an uncertain graph from creating a
false cache hit. A `requires` reference to a nonexistent node is a configuration
error rather than a guessed fallback. Dependencies omitted from the manifest
cannot be inferred; the final full verification and real AWS deployment remain
the backstops for dependencies that were not modeled locally.

## State And Reproducibility

The impact ledger and attestations live under the plugin's project-local
`.anbo/state` namespace. Build and Terraform fingerprint caches live under the
user cache namespace. None are written into `.anbo/sandbox.json`, Terraform
source, or build contexts, and `.anbo/state` should not be committed.

`anbo down --purge` removes the managed MiniStack containers, networks, volume,
and private Terraform directory. It intentionally retains supervisor and impact
metadata under `.anbo/state`, build images and caches, and clone metadata. Use
`anbo cache prune` for build artifacts and `anbo down --purge-clones` for owned
Anbo Cloud clone branches.

The ledger is updated by phase. A passing runtime, build, Terraform root, or
service can therefore be reused even if a later test fails. A malformed or
newer ledger never creates a cache hit; Anbo reports the issue and falls back to
a conservative cold plan.

For agent automation, retain the JSONL stream from every command. It provides
ordered phase timing, selection reasons, diagnostic evidence, correlation IDs,
and exact rerun commands without requiring the agent to parse terminal prose.

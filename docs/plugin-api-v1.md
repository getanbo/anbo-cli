# Plugin API v1

## Discovery and activation

Projects select plugins in `.anbo/project.json`. First-party IDs have a static package mapping; custom IDs must declare their package explicitly. The host resolves only that package from the project, the current installation, or the CLI's own exact dependencies.

Every package exports `./descriptor` as JSON. The host reads and validates this file before importing executable code. It then verifies the installed package name and version, engine ranges, target declarations, schema path, runtime descriptor agreement, and `.anbo/plugins.lock.json`.

The static manifest may include distribution metadata such as `package`, `entrypoint`, `kinds`, `commands`, `config`, and `capabilities`. The runtime descriptor uses the same `PluginDescriptorV1` type and must agree on identity, version, API, and targets.

## Runtime

The package default export implements `AnboPluginV1`:

```ts
type AnboPluginV1 = {
  descriptor: PluginDescriptorV1;
  activate(context: PluginContextV1): PluginRuntimeV1 | Promise<PluginRuntimeV1>;
};
```

`PluginRuntimeV1.targets` may be an array of providers with IDs or a record keyed by target ID. Commands may be an array of named providers or a record keyed by a namespaced command such as `cloud.branch`. Plugins never register unnamespaced commands.

Target requests include API version `1`, the host-owned canonical `run_id`, action, stable logical/runtime project IDs, namespaced config, parsed arguments and flags, plus `passthrough` for tokens after `--`. The `args` array also retains the `--` marker for compatibility. A plugin must never derive or accept a replacement run ID from a user flag.

## Host ownership

Core owns global parsing, plugin selection, stdout/stderr, human/JSON/JSONL rendering, event envelopes, run IDs, sequencing, redaction, signals, exit codes, state paths, and plugin locks. Plugins emit semantic events through `context.events` and never write directly to terminal streams.

The activation context is scoped to one plugin and provides:

- `signal`: cancellation for the complete run.
- `events`: semantic events and phase lifecycle helpers.
- `process`: shell-free child processes with live output, capture, timeout, and cancellation. `process.cleanup` is a bounded teardown-only escape hatch that remains available after cancellation so plugins can release resources they created; ordinary work must use `process.run`.
- `http`: fetch-compatible requests tied to cancellation.
- `state` and `credentials`: serialized namespaced storage.
- `secrets`: `env://`, `env:`, and trusted `exec://` references.
- `adapters`: the extension boundary for providers not covered by the target plugin.
- `paths`: plugin-specific state, cache, and durable data directories.

## Results and failures

Canonical target results use `status: succeeded | failed | cancelled`, optional structured data, and diagnostics with stable codes and remediation. The host temporarily accepts legacy `{ ok: boolean }` results during the first-party plugin migration.

`retryable` means the same request may succeed without changing code or configuration, and is reserved for transient conditions. `safe_to_retry` means repeating the operation after the reported remediation will not knowingly duplicate side effects. A deterministic validation, build, or test failure is therefore `retryable: false, safe_to_retry: true`; an ambiguous remote create can be `retryable: true, safe_to_retry: false`.

Core exit codes are `0` success, `2` usage/configuration, `3` plugin unavailable, `4` plugin incompatible, `5` operation failure, and `130` cancellation. Every started machine-readable run terminates with exactly one `run.finished` event.

# Anbo CLI

Anbo is an agent-first CLI for creating reproducible local and remote deployment environments. This monorepo is the canonical source of the `anbo` executable, the public plugin contracts, and every first-party target plugin.

## Install

The first public release is prepared as `anbo@0.2.0`. Until it is published to npm, build and install the package from this repository:

```sh
git clone https://github.com/getanbo/anbo-cli.git
cd anbo-cli
npm ci
npm run build
mkdir -p /tmp/anbo-packages
npm pack --workspace packages/plugin-sdk --pack-destination /tmp/anbo-packages
npm pack --workspace packages/cli --pack-destination /tmp/anbo-packages
npm pack --workspace plugins/ministack --pack-destination /tmp/anbo-packages
npm pack --workspace plugins/cloud --pack-destination /tmp/anbo-packages
npm install --global /tmp/anbo-packages/*.tgz
anbo version
```

After publication:

```sh
npm install --global anbo @getanbo/plugin-ministack
```

## MiniStack Project

Run these commands from a project containing Terraform:

```sh
anbo configure --target ministack
anbo doctor --output jsonl
anbo deploy --output jsonl
anbo status --output jsonl
anbo test --output jsonl -- npm test
anbo logs --follow --output jsonl
anbo debug --output jsonl
anbo run --output jsonl -- node -e 'console.log("ready")'
anbo reset --no-test --output jsonl
anbo down --purge --output jsonl
```

If Terraform or Dockerfiles are added after the initial configuration, run
`anbo configure --target ministack --refresh`. Deploy also repairs the generated
empty-project placeholder automatically without replacing user configuration.

`anbo sandbox up` remains an alias for `anbo deploy --target ministack`.

## Cloud Project

The Cloud plugin owns the remote target and namespaced commands:

```sh
anbo configure --target cloud
anbo deploy
anbo cloud branch list
anbo cloud sql --env-id example --command "select 1"
```

The previous `anbo login`, `logout`, `auth`, `demo`, `branch`, `token`, `sql`, `report`, and `test-status` forms route to their corresponding `cloud.*` commands. Top-level `test-run` remains the target lifecycle alias; `anbo cloud test-run` invokes the namespaced Cloud command.

## Configuration

`anbo configure` creates two committed project files:

- `.anbo/project.json` selects targets and contains only namespaced plugin configuration.
- `.anbo/plugins.lock.json` records exact package versions and npm integrity when available.

Plugin discovery is explicit. Anbo never scans arbitrary global packages, `$PATH`, or every dependency in `node_modules`. First-party target names map to exact packages, and custom plugins must be declared in `.anbo/project.json`.

## Machine Output

Use `--output jsonl` for agents and CI. Each line is one `anbo.dev/event/v1` object with a stable run ID, contiguous sequence, timestamp, source, command, target, severity, and structured data. Core owns stdout, cancellation, redaction, diagnostic codes, and the single terminal `run.finished` event.

Use `--output json` for one buffered run document or the default human output for a terminal. Machine modes never mix explanatory text into stdout or stderr.

## Plugin API v1

A plugin exports a static `./descriptor` JSON entry and default-exports:

```ts
import type { AnboPluginV1 } from "@getanbo/plugin-sdk";

const plugin: AnboPluginV1 = {
  descriptor,
  async activate(context) {
    return { targets: [targetProvider] };
  },
};

export default plugin;
```

The host supplies namespaced state, credentials, secrets, adapter access, filesystem paths, process and HTTP primitives, structured events, and an `AbortSignal`. Plugins do not parse global options or write directly to stdout/stderr.

The contract and schemas live in [`packages/plugin-sdk`](packages/plugin-sdk) and [`schemas`](schemas). `@getanbo/plugin-testkit` runs an installed `node_modules/.bin/anbo` and validates event streams.

## Testing Rule

Unit tests may call native modules. Every behavioral, integration, smoke, recovery, and release-qualification test must pack the real packages, install them into an empty prefix, and invoke only `node_modules/.bin/anbo`. The harness must not call Terraform, Docker, plugin entrypoints, or application smoke scripts directly.

```sh
npm ci
npm run check
```

`npm run check` performs type checking, native package tests, and packed installed-CLI acceptance for both first-party plugins. It includes cold/warm host fixtures, Cloud API workflows, passthrough commands, structured logs, secret redaction, cancellation, and teardown.

The scheduled/dispatchable **Official plugins acceptance** workflow packs every candidate workspace at one exact commit, installs them together into an empty prefix, runs the real MiniStack and Cloud flows exclusively through `.bin/anbo`, and retains their JSONL diagnostics.

## Repository Boundaries

- [`packages`](packages): executable, SDK, event protocol, config, locks, and acceptance kit.
- [`plugins/ministack`](plugins/ministack): local Terraform and MiniStack target.
- [`plugins/cloud`](plugins/cloud): remote Anbo Cloud target.
- [`getanbo/anbo-ministack`](https://github.com/getanbo/anbo-ministack): downstream patch-staging mirror; the plugin runtime remains pinned to an exact official upstream image.
- [`getanbo/anbo-k8s`](https://github.com/getanbo/anbo-k8s): hosted backend and infrastructure consumed by the Cloud plugin.
- [`getanbo/anbo-example-notes`](https://github.com/getanbo/anbo-example-notes): external reference consumer and full product acceptance flow.

Release promotion is split to avoid a dependency cycle: SDK and testkit first, both plugins next, and the `anbo` package last. See [`docs/releasing.md`](docs/releasing.md).

## License

MIT

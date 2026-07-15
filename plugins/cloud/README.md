# Anbo Cloud plugin

Anbo Cloud is the hosted-environment target for the canonical
[`anbo`](https://github.com/getanbo/anbo-cli) command-line interface. It contains the
client behavior previously embedded in the Anbo infrastructure repository.

This package intentionally has no executable. The canonical CLI owns command
parsing, target selection, state, credentials, cancellation, redaction, and
human/JSON/JSONL rendering.

## Agent workflow

```bash
anbo configure --target cloud
anbo deploy --target cloud --image ghcr.io/example/notes:sha --sha sha
anbo status --target cloud env-notes-sha --output jsonl
anbo test --target cloud env-notes-sha --image ghcr.io/example/notes:sha -- npm run smoke
anbo logs --target cloud env-notes-sha run-id --follow --output jsonl
anbo down --target cloud env-notes-sha
```

Cloud-specific operations are namespaced:

```bash
anbo cloud branch list
anbo cloud token create
anbo cloud sql env-id --command "select 1"
anbo cloud report env-id run-id
```

## Contract

`anbo.plugin.json` declares Plugin API v1 compatibility. The versioned Anbo
Environment API client contract is stored in
`openapi/anbo-env-api.v1.yaml`; generated types are committed so contract drift
is visible in review.

The plugin emits typed events through the SDK context. It never writes directly
to stdout or stderr and never persists resolved secrets in plugin state.

## Development

```bash
npm ci
npm run generate:api
npm run check
```

The Cloud repository also certifies its retained behavior through the packed
canonical host:

```bash
ANBO_CLI_TARBALL=/path/to/anbo-0.2.0.tgz \
ANBO_PLUGIN_SDK_TARBALL=/path/to/getanbo-plugin-sdk-0.2.0.tgz \
npm run test:installed-cli
```

This acceptance suite packs the Cloud plugin, installs every candidate into an
empty prefix, starts a local mock Env API, and invokes only the installed
`node_modules/.bin/anbo` executable. It covers configuration, deployment and
polling, remote tests and diagnostics, teardown, and PostgreSQL and DynamoDB
branch cloning. Direct plugin entrypoints are deliberately outside this test
boundary.

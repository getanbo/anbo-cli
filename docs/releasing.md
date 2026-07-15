# Releasing

The packages share one source commit but remain independently published artifacts. Promotion is intentionally ordered to avoid a dependency cycle. Do not publish until the candidate matrix has passed.

## Promotion order

1. Run the required packed CLI fixture acceptance and **Official plugins acceptance** against one candidate commit.
2. Dispatch **Release foundation packages** with `0.2.0`. This publishes `@getanbo/plugin-sdk@0.2.0` and `@getanbo/plugin-testkit@0.2.0` only.
3. Dispatch **Release first-party plugin** for `ministack` at `0.1.0`, using the certified Anbo MiniStack image digest already pinned in the workspace.
4. Dispatch **Release first-party plugin** for `cloud` at `0.1.0`.
5. Dispatch **Finalize CLI release** with `0.2.0`. It verifies all four dependencies in npm and publishes `anbo@0.2.0` last.
6. Record the CLI, SDK, testkit, plugin versions/integrities, runtime image digest, and schema hashes in the compatibility manifest.

Every publishing workflow queries npm before publishing. An already-published exact version is treated as success and is never overwritten. Registry lookup, authentication, and network failures are not treated as absence; only an npm `E404` permits publication.

Repository tags are optional bookkeeping and must be package-prefixed when used, for example `cli-v0.2.0` or `plugin-ministack-v0.1.0`. Bare `v*` tags are intentionally not release triggers because package versions differ.

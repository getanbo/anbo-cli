# Releasing

The release is intentionally split to avoid a dependency cycle. Do not create or push release tags until the candidate matrix has passed.

## Promotion order

1. Run the required CLI fixture acceptance and the cross-repository ecosystem acceptance against the candidate commits.
2. Push `v0.2.0` in `getanbo/cli`, or dispatch **Release foundation packages** with `0.2.0`. This publishes `@getanbo/plugin-sdk@0.2.0` and `@getanbo/plugin-testkit@0.2.0` only.
3. Publish `@getanbo/plugin-ministack@0.1.0` against that exact SDK and its certified Anbo MiniStack image digest.
4. Publish `@getanbo/plugin-cloud@0.1.0` against that exact SDK.
5. Dispatch **Finalize CLI release** with `0.2.0`. It verifies all four dependencies in npm and publishes `anbo@0.2.0` last.
6. Record the CLI, SDK, testkit, plugin versions/integrities, runtime image digest, and schema hashes in the compatibility manifest.

Both workflows query npm before publishing. An already-published exact version is treated as success and is never overwritten. Registry lookup, authentication, and network failures are not treated as absence; only an npm `E404` permits publication.

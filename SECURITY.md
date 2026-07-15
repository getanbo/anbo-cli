# Security Policy

## Reporting

Do not open public issues for suspected vulnerabilities. Report them through GitHub's private vulnerability reporting for `getanbo/cli`. Include affected versions, reproduction steps, impact, and any suggested remediation.

## Supported Versions

Security updates are provided for the latest published minor release.

## Trust Boundaries

Anbo plugins execute with the user's permissions. Install plugins only from trusted publishers and commit `.anbo/plugins.lock.json`. Plugin discovery is explicit and validates the package identity, static descriptor, version, engine range, config schema, and available integrity before activation.

`exec://` secret references intentionally execute a command from trusted project configuration. Never accept an unreviewed project configuration as safe. Structured output is redacted, but plugins must avoid placing secrets in process arguments or unmanaged files.

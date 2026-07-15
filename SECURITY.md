# Security

## Supported Versions

Until the Anbo MiniStack plugin reaches 1.0, only the latest published minor release receives
security fixes.

## Reporting A Vulnerability

Do not open a public issue containing exploit details, credentials, clone URLs,
or Terraform state. Use GitHub's **Report a vulnerability** action on the
repository Security tab to open a private security advisory. Include the plugin
version, operating system, Docker version, reproduction steps, and the
smallest redacted event output that demonstrates the problem.

## Trust Model

The Anbo MiniStack target is not a security sandbox or a boundary for untrusted code. It may:

- execute project-defined build and test commands on the host;
- download and execute Terraform providers and modules;
- execute configured adapter programs;
- build and run project containers;
- mount the Docker daemon socket into MiniStack for compute services; and
- inject clone credentials into containers that explicitly request them.

Only run trusted repositories, Terraform modules, container images, and
adapters. Treat the host account and Docker daemon as part of the trust
boundary. A user or container with access to the daemon can inspect other
containers and may be able to gain host-level control.

Anbo redacts registered secrets from its event stream and keeps them out of its
generated Terraform state. Those credentials can still be visible to a local
administrator through process or Docker inspection. Use short-lived,
least-privilege credentials and production-derived datasets that have been
appropriately minimized.

`network.allow_hosts`, `network.clone_egress`, and adapter `allowed_hosts` are
currently declarations, not enforced firewalls. Application containers use a
normal Docker network and may have outbound network access. Terraform
plan/apply isolation does not make project code safe to execute.

## Summary

Describe the user-visible behavior and which package or plugin owns it.

## Verification

- [ ] Native unit, type, schema, and package tests pass
- [ ] Behavioral claims use packed packages installed into an empty prefix
- [ ] Behavioral tests invoke only that installation's `node_modules/.bin/anbo`
- [ ] Plugin API changes cover both first-party plugins
- [ ] Documentation and capability declarations match the behavior
- [ ] No credentials, clone URLs, Terraform state, `.anbo` data, or archives are committed

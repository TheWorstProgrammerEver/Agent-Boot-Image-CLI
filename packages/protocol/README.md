# Agent Boot protocol

This package defines the provider-neutral and OS-neutral JSON contracts shared
by synthesis, imaging adapters, and the on-image runner. It performs validation
only: importing or parsing a schema does not execute definitions, commands,
providers, mounts, or device operations.

The three canonical runtime schemas are:

- `manifestSchema` for image/bootstrap data and assembly file descriptors;
- `runnerPlanSchema` for ordered runner steps and provider descriptors;
- `osLockSchema` for an immutable curated OS selection.

`assemblyDocumentsSchema` parses the three documents together and validates
cross-document agent, prompt, and asset references. The checked-in
`fixtures/assembly` directory demonstrates the complete version 1 layout and
every runner-step variant.

Consumers must call `assertCompatibleSchemaVersion` before detailed parsing.
Schemas are strict and reject unknown fields. Credential content is represented
only by `secretId`; ordinary manifests and runner plans have no password, token,
private-key, or credential-value fields.

# ADR 0007: Versioned assembly protocol compatibility

- Status: Accepted
- Date: 2026-07-19

## Context

The imaging CLI, OS adapter, and private target runner are released separately
but exchange immutable JSON. Silent acceptance of an unknown document shape can
misconfigure an image or make a resumed runner interpret ordered work
differently from the synthesizer that produced it.

Image/bootstrap concerns and ordered target execution also have different
owners. Combining them would expose host-only or OS-specific data to the runner
and make independent compatibility checks difficult.

## Decision

`@agent-boot/protocol` is the zero-dependency owner of the serialized contracts.
An assembly has this canonical layout:

```text
assembly/
  manifest.json
  runner-plan.json
  os-lock.json
  assets/
  prompts/
```

Each JSON boundary has exactly one strict runtime schema. Every schema rejects
unknown fields and carries an integer `schemaVersion`. Version 1 is the initial
version for all three boundaries.

`manifest.json` owns image/bootstrap inputs, canonical file locations, asset and
prompt descriptors, and runner installation references. `runner-plan.json` owns
only ordered target steps and provider execution descriptors. `os-lock.json`
owns the immutable selected OS artifact and its generic compatibility metadata.

Consumers call `assertCompatibleSchemaVersion` before detailed parsing. A
missing or unsupported version fails closed and reports the consumer, document,
received version, supported versions, and the recovery choice: regenerate with
a compatible CLI or update the consumer. Detailed parsing still requires the
exact current version, so callers cannot bypass negotiation by ignoring it.

Schema evolution uses a new integer version for any incompatible serialized
change. A consumer may explicitly list multiple supported versions only while
it has separate validated parsing or migration behavior for each. Unknown
fields never serve as implicit forward compatibility.

Credential-bearing fields are not part of ordinary manifests or runner plans.
Bootstrap passwords, Wi-Fi passphrases, prompt secret substitutions, and secret
installation steps carry validated `secretId` references only. Environment keys
that conventionally carry credentials are rejected. Secret contents are
resolved only at the later authorized materialization boundary from ADR 0005.

## Consequences

- CLI/runner skew produces actionable diagnostics instead of best-effort
  execution.
- The runner does not consume OS artifact, account, network, or installation
  data after bootstrap.
- The assembly writer remains a separate layer over the protocol contracts.
- Adding or changing serialized fields requires a deliberate compatibility
  decision, fixtures, and rejection tests.

# ADR 0005: Secret materialization and redaction boundary

- Status: Accepted
- Date: 2026-07-19

## Context

Definitions may describe credentials needed after first boot, but ordinary
validation and synthesis must remain reproducible and safe to inspect. Raw secret
values in assemblies, logs, errors, checkpoints, or test fixtures would create
long-lived copies and make routine diagnostics unsafe.

## Decision

Definition and assembly APIs carry secret references and destination intent, not
raw secret values. Synthesis and ordinary validation never resolve those
references. Secret materialization is a later imaging/customization operation at
the narrowest boundary that can write the intended target location.

All process output, structured diagnostics, errors, checkpoints, and serialized
status cross a redaction boundary before persistence or display. Redaction uses
known sensitive values and sensitive field metadata; it is not deferred to a
logging backend. Temporary material must be minimally scoped and removed on both
success and failure. Tests use conspicuous non-secret sentinels.

Because a definition is trusted executable code, the runtime cannot prevent it
from reading host data directly. The supported APIs neither require nor preserve
raw values, and operators remain responsible for reviewing definition code.

## Consequences

- Synthesized assemblies are inspectable without exposing secret contents.
- Secret resolution errors occur in a later, explicitly authorized phase.
- Every adapter that emits output must use the shared redaction contract.
- Resume state must identify secret work without recording secret material.

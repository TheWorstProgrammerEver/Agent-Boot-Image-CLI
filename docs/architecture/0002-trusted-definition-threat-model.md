# ADR 0002: Trusted definition threat model

- Status: Accepted
- Date: 2026-07-19

## Context

TypeScript definition files are executable programs. A type-safe API does not
make an arbitrary definition safe to execute, and a lightweight in-process
sandbox would create a misleading security boundary.

## Decision

Definition files are trusted code with the same authority as the user running
the CLI. The project does not claim to sandbox them. Operators must review and
trust a definition and its transitive imports before evaluation.

Untrusted values may enter a trusted definition only as data. They are parsed and
validated at explicit boundaries and are never converted into source code or
implicit shell commands. Definition evaluation is separate from privileged image
mutation so that trust in a definition does not automatically authorize a device
operation; destructive operations will require their own explicit target and
safety gates in later work.

Routine validation and CI use inert definitions or fixtures and never execute
third-party definition source.

## Consequences

- Installing or evaluating a definition is a code-trust decision.
- Documentation and diagnostics must not describe definitions as sandboxed.
- Provider-neutral schemas remain suitable for untrusted serialized input after
  boundary validation, even though the source definition is trusted.
- Privilege and destructive-target authorization remain separate concerns.

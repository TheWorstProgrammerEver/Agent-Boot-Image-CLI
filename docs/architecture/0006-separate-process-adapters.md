# ADR 0006: Separate process adapters

- Status: Accepted
- Date: 2026-07-19

## Context

Short commands that return bounded output have different lifecycle and safety
requirements from streaming or long-running child processes. A single permissive
command helper tends to grow shell interpolation, unbounded buffers, ambiguous
cancellation, and difficult-to-fake behavior.

## Decision

`@agent-boot/process` owns provider-neutral contracts with separate adapters for:

1. bounded execution with captured output and explicit size/time limits; and
2. spawned processes with structured arguments, streaming, signals, cancellation,
   and optional inherited terminal behavior.

Callers pass an executable and an argument array rather than interpolating a
shell command. The spawn adapter always invokes `spawn()` with `shell: false`.
The bounded adapter safely quotes that structured descriptor for the separately
versioned, POSIX-only Typescript-Bash implementation; raw shell strings are not
part of the shared command-host contract. Process output crosses the shared
redaction boundary before it is logged or persisted. Tests use a fake command
host implementing the same narrow contracts; OS adapters depend on those
contracts rather than Node process APIs.

## Consequences

- Callers choose lifecycle semantics deliberately.
- Bounded execution cannot silently become a long-running process facility.
- Process behavior is replaceable in tests without privileged commands.
- Shell-specific behavior requires a visible, separately reviewed adapter.

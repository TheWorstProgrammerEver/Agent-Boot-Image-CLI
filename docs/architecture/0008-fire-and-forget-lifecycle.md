# ADR 0008: Runner-lifetime fire-and-forget processes

- Status: Accepted
- Date: 2026-07-19

## Context

The runner plan has a fire-and-forget step with `lifetime: "runner"`. Treating
that field as a detached-process boolean would leave launch acceptance, crash
windows, duplicate suppression, reboot recovery, and shutdown ownership
undefined. PID alone is also unsafe recovery identity because Linux can reuse
it.

The definitive use case starts a foreground support service for later runner
steps. It must remain available while the sequence is active, but it must not
outlive the runner that owns it.

## Decision

Protocol version 1 supports only `lifetime: "runner"`. It maps to an isolated,
managed POSIX process group. Reboot- or machine-durable processes are not
silently approximated with detachment; those values fail protocol validation
until an external service-manager contract defines installation, identity,
readiness, restart, and removal.

A launch is accepted only after all of the following occur:

1. structured `spawn()` succeeds without a shell;
2. the child has a PID and leads its isolated process group;
3. the runner records Linux boot ID, PID, process-group ID, and `/proc` start
   ticks in the atomic checkpoint; and
4. the same stable identity remains alive for the configured acceptance
   window.

Synchronous spawn or identity-capture failures are launch failures. Exit before
the window is an early process exit. Exit after acceptance is a later lifecycle
failure and does not get relabeled as a launch failure. Launch retries are
bounded independently from foreground automatic-step retries.

Checkpoint schema version 2 records one current generation per fire-and-forget
step. It contains stable identity, lifecycle phase, bounded timestamps, exit
code, signal, and outcome. Executable arguments, environment values, output,
and exception text have no persisted field.

Recovery is conservative:

- a registered current attempt is adopted and finishes its acceptance window
  when the stable identity is still alive;
- an accepted process from an unfinished sequence is adopted on the same boot,
  suppressing a duplicate launch;
- a missing accepted process on the same boot is a later lifecycle failure;
- after a reboot, a completed fire-and-forget step is relaunched only when the
  overall sequence is unfinished, because runner-lifetime processes do not
  survive reboot; and
- a registered or failed in-flight launch from a prior boot consumes its
  recorded attempt before a safe relaunch may use the next bounded attempt;
- an explicit runner-shutdown checkpoint may relaunch the interrupted attempt
  because the runner proved cleanup before returning; and
- a started step without stable process metadata is treated as ambiguous and
  consumes its launch attempt without spawning again.

The runner owns cleanup. Before terminal success, terminal failure, or
cancellation returns, it stops every tracked or adopted runner-lifetime process
and waits for cleanup. Cancellation may forward a supported catchable POSIX
signal through the managed cancellation path; invalid, `SIGKILL`, and
`SIGSTOP` reasons become `SIGTERM`. Fire-and-forget children do not install
independent parent-signal listeners. The systemd composition layer must convert
runner service signals into the runner cancellation signal.

## Consequences

- A fire-and-forget step means accepted supervised launch, not successful
  eventual completion.
- Same-boot recovery prioritizes duplicate suppression over guessing after an
  uncheckpointed spawn.
- Reboot recovery can reconstruct commands and public environment from the
  immutable runner plan without persisting command arguments or resetting the
  persisted launch-attempt budget.
- Runner shutdown cannot intentionally leave these processes behind.
- A future durable lifetime requires a new protocol value and service-manager
  ADR rather than a change to the meaning of `runner`.

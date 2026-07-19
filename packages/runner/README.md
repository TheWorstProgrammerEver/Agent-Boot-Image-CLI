# `@agent-boot/runner`

`RunnerEngine` validates the exact serialized runner plan before execution and currently accepts
environment, foreground automatic, and physical-console manual steps. A plan containing a later
executor kind fails as incompatible before any command starts, so adding fire-and-forget, prompt,
provider, and secret executors cannot accidentally produce a partial run.

The engine snapshots its configured account home, default working directory, and base `PATH`.
Completed environment set/unset operations are deterministically replayed from the immutable plan
when forming each separately spawned child environment. Automatic commands use managed foreground
processes, checkpoint only after exit code zero, and obey explicit maximum-attempt and timeout
bounds. Recovery treats a persisted `started` automatic attempt as ambiguous in-flight work: it
durably consumes that attempt without spawning again, then either advances to the next numbered
attempt or requires manual intervention at the bound. Progress and terminal failures contain only
step identity, attempt, exit status, signal, and recovery action; command output, arguments, and
environment values are excluded.

Manual gates checkpoint `started` before probing or launching their interactive command. A silent
completion probe runs first, so an already-completed or reboot-resumed gate can advance without
relaunching the interactive command. Otherwise the command receives inherited foreground stdio and
forwarded `SIGHUP`, `SIGINT`, and `SIGTERM`, while completion probes use ignored stdin, drained and
discarded output, managed process cleanup, and an explicit timeout. Probe delays back off
exponentially to a configured cap. Completion cancels and awaits the foreground process before the
success checkpoint; an exited command without a successful final probe, a start failure, or a probe
infrastructure failure becomes a redacted terminal diagnostic. Progress events distinguish waiting,
probe retry, completion, and terminal failure without carrying commands, arguments, output, or
environment values.

The checkpoint store persists only recovery-critical state. It records the exact runner-plan
identity, monotonic step attempts, secret-install transaction phases, terminal outcome, and
structured diagnostics that cannot contain command output or secret values.

On Linux, each update writes a mode `0600` temporary file in the checkpoint directory, syncs the
file, renames it over the checkpoint, and syncs the directory. Before cleanup, reads, or writes, the
store verifies that the checkpoint directory belongs to the runner user and is not writable by group
or others. Startup then removes interrupted same-directory temporary artifacts and syncs the
directory before inspecting state, which also finishes a retry after interruption between rename and
directory sync. The store is serialized within one process and is intended to have one runner owner;
cross-process execution locking belongs to runner startup sequencing.

Call `inspect()` before recovery. Only `valid` state may resume automatically. Absent, stale-plan,
incompatible, corrupt, and unsafe storage-trust results are distinct, and mutation methods fail
closed for every result except valid state (or absent state during explicit initialization).

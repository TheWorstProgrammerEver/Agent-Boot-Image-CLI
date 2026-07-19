# `@agent-boot/runner`

`RunnerEngine` validates the exact serialized runner plan before execution and currently accepts
only environment and foreground automatic steps. A plan containing a later executor kind fails as
incompatible before any command starts, so adding manual, fire-and-forget, prompt, provider, and
secret executors cannot accidentally produce a partial run.

The engine snapshots its configured account home, default working directory, and base `PATH`.
Completed environment set/unset operations are deterministically replayed from the immutable plan
when forming each separately spawned child environment. Automatic commands use managed foreground
processes, checkpoint only after exit code zero, and obey explicit maximum-attempt and timeout
bounds. Progress and terminal failures contain only step identity, attempt, exit status, signal, and
recovery action; command output, arguments, and environment values are excluded.

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

# `@agent-boot/runner`

`RunnerEngine` validates the exact serialized runner plan before execution and accepts environment,
foreground automatic, physical-console manual, runner-lifetime fire-and-forget, prompt, and provider
steps when their executors are configured. A plan containing a later executor kind fails as
incompatible before any command starts, so adding secret executors cannot accidentally produce a
partial run.

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

Prompt templates and immutable assets resolve only from IDs declared by the assembly manifest. The
resolver rejects traversal and symlink components, requires regular files, and verifies manifest
digests (plus asset byte lengths) before hydration. Variable bindings resolve only from the replayed
public environment or an injected `secretId` resolver. Unresolved, malformed, missing, or modified
inputs fail with bounded diagnostics that contain no substitution values.

Rendered prompts are atomically materialized beneath `/run/agent-boot/prompts/<agent-id>` through a
mode `0600` file and mode `0700` directories. The runner removes each file before provider launch
after retaining its bytes for structured stdin, and removes the agent runtime directory on every
exit path. A provider step always rehydrates its producing prompt, so a reboot that clears `/run`
regenerates the input without checkpointing prompt content or paths.

Provider execution depends on the provider-neutral `ProviderDescriptorAdapter` boundary. The first
adapter maps a serialized Codex descriptor to a managed process with deliberate cwd, inherited
runner environment, timeout, signals, streamed/discarded output, and hydrated stdin. Codex is not a
runner-plan discriminator and the sequence engine does not import its adapter. Provider output,
prompt input, command arguments, and environment values never enter progress or checkpoint state.

Fire-and-forget launch is accepted only after the managed child leads an isolated process group,
its Linux boot ID/PID/process-group/start-tick identity is durably registered, and that identity
survives a bounded acceptance window. The checkpoint excludes executable arguments, environment,
output, and exception text. Same-boot recovery adopts a matching accepted identity to suppress
duplicates and treats a missing accepted identity as a later process failure. Reboot recovery
relaunches completed runner-lifetime steps only while the overall sequence remains unfinished;
registered and failed in-flight launches consume their recorded attempt before any bounded retry.
Every tracked or adopted child is stopped before runner success, failure, or cancellation returns.
The lifecycle policy and unsupported durable-lifetime boundary are recorded in
[ADR 0008](../../docs/architecture/0008-fire-and-forget-lifecycle.md).

User-secret installation maps each declared secret ID to one regular, non-symlink, single-link file
under `/etc/agent-boot/bootstrap-secrets`. The destination is a normalized relative path resolved
beneath the configured account home; symlink directory components and containment escapes are
rejected. Destination directories are made private with mode `0700`, and secret bytes are written to
a mode `0600` same-directory temporary file, synced, assigned the configured uid/gid, atomically
renamed, and verified for content, ownership, mode, type, and link count before source removal.

The persisted `prepared`, `installed`, `source-removed`, and `committed` phases make each boundary
reboot-safe. Retry removes abandoned destination temporary files, validates any existing source
against the installed bytes before unlinking it, and refuses to delete a replaced source. The source
directory is synced after unlink and the step cannot succeed before the committed checkpoint.
Source cleanup is automatic; declarations do not author a cleanup command. Progress explicitly
labels source deletion as `unlink-not-secure-erase`: unlinking and syncing a directory removes the
filesystem name durably but does not promise physical secure erasure from storage media.

The checkpoint store persists only recovery-critical state. It records the exact runner-plan
identity, monotonic step attempts, stable fire-and-forget process metadata, secret-install
transaction phases, terminal outcome, and structured diagnostics that cannot contain command
output or secret values.

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

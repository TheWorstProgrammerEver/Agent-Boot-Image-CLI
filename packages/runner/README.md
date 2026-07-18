# `@agent-boot/runner`

The runner checkpoint store persists only recovery-critical state. It records the exact runner-plan
identity, monotonic step attempts, secret-install transaction phases, terminal outcome, and
structured diagnostics that cannot contain command output or secret values.

On Linux, each update writes a mode `0600` temporary file in the checkpoint directory, syncs the
file, renames it over the checkpoint, and syncs the directory. Startup removes interrupted
same-directory temporary artifacts and syncs the directory before inspecting state, which also
finishes a retry after interruption between rename and directory sync. The store is serialized within one
process and is intended to have one runner owner; cross-process execution locking belongs to runner
startup sequencing.

Call `inspect()` before recovery. Only `valid` state may resume automatically. Absent, stale-plan,
incompatible, corrupt, and unsafe-permission results are distinct, and mutation methods fail closed
for every result except valid state (or absent state during explicit initialization).

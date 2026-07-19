# `@agent-boot/process`

Shared command boundaries for the Agent Boot workspace. Callers pass an
executable, argument array, scoped environment overrides, and working directory;
neither public descriptor asks callers to interpolate a shell command.

## Bounded execution

`TypescriptBashExecAdapter` accepts the public `bash()` function from `ts-bash`
and safely quotes a structured descriptor for that POSIX-only bounded executor.
This boundary is only for short commands whose stdout and stderr fit in memory.
It cannot stream, inherit a terminal, detach, forward signals, or represent a
long-running process.

```ts
import { bash } from 'ts-bash';
import { TypescriptBashExecAdapter } from '@agent-boot/process';

const commands = new TypescriptBashExecAdapter(bash);
const result = await commands.exec({
  executable: 'git',
  arguments: ['rev-parse', 'HEAD'],
  label: 'read repository revision',
  timeoutMs: 5_000,
  maxOutputBytes: 64 * 1024,
});
```

The dependency is injected because `ts-bash` is delivered and versioned in its
own repository. Its maximum timeout and output bounds remain authoritative.

## Spawned processes

`NodeSpawnAdapter` uses `spawn()` with `shell: false`. Every call selects
streamed or inherited stdio and an explicit lifetime policy:

- `managed`: the adapter owns a POSIX process group and removes descendants on
  cancellation, timeout, or parent exit.
- `detached`: the child has an independent lifetime; `unref` must be selected
  explicitly, and an unreferenced child cannot retain streamed pipes.

Managed and referenced-detached commands return a `RunningCommand` with a
completion promise, cancellation, and direct signal methods. Optional parent
signal forwarding is installed only for the command lifetime and removed on
completion. Streamed commands may provide deliberate string or byte-array
stdin; this cannot be combined with inherited stdio, and stdin is omitted from
all command representations and diagnostics.

## Redaction and tests

`sensitiveValues` plus a host-level `Redactor` protect ordinary command
representations, errors, and captured failure diagnostics. Environment values
are never included in command representations. Successful captured output and
stream chunks remain command data; callers must route anything logged or
persisted through the same redaction boundary.

`FakeCommandHost` records immutable call snapshots and scripts bounded results,
spawn output, completions, and failures for routine tests without creating child
processes.

# `create-agent validate`

Validate a trusted Agent Boot TypeScript definition before synthesis or device
operations are available:

```console
create-agent validate ./my-agent.ts
```

> **Security warning:** the definition and every module it imports are trusted
> executable code. Validation executes that code with the CLI process's host
> permissions. Review its full import graph before running this command.

The command requires a module with exactly one runtime export named `default`,
normalizes that value through `@agent-boot/definition`, checks schema/protocol
compatibility, and inspects local reference metadata. Relative references are
rooted at the definition file. Validation does not read referenced contents,
serialize the definition to output, run definition commands, contact providers,
download images, or inspect devices.

Exit codes are stable for automation:

| Code | Meaning |
| ---: | --- |
| 0 | Definition is valid. |
| 2 | Export, schema, or reference metadata is invalid. |
| 3 | Definition protocol is incompatible with this CLI. |
| 4 | The module or reference metadata could not be loaded operationally. |
| 64 | Command usage is invalid. |

# `create-agent synth`

Synthesize a validated definition with OS and private-runner inputs resolved by
their owning components:

```console
create-agent synth \
  --definition ./my-agent.ts \
  --output ./assembly \
  --os-lock ./resolved-os-lock.json \
  --runner-runtime ./runner/node \
  --runner-entrypoint ./runner/entrypoint.mjs
```

The command copies regular, non-symlink assets, prompts, and scripts only when
they remain beneath the definition directory. Secret references are retained as
opaque `secretId` values; their files are inspected at the metadata boundary but
never opened or copied. Existing output is refused unless `--replace` is passed.
Use `--plan` to print the redacted counts and deterministic assembly identifier
without writing output.

Additional synthesis exit codes are `5` for rejected synthesis input, `6` for
existing output without `--replace`, and `7` for an operational or atomic-output
failure.

# `create-agent drives list`

Inspect Linux block-device topology without mutating devices:

```console
create-agent drives list
```

The command reports whole disks, exact `/dev/disk/by-id` aliases, size, model,
transport, removable status, and redacted serial presence. It marks the active
system disk, mounted descendants, non-removable disks, and disks without a
stable alias as blocked. Mount paths and standalone serial fields are omitted.
The later image command must still run the complete preflight; list output is
orientation, not authorization.

The exported image-target guardrail API requires an explicit by-id target plus
expected model, serial, removable status, transport, and maximum size. It prints
a redacted plan before interactive acknowledgement or `--yes`, then resolves
and rechecks the complete target identity immediately before entering the
downstream lock callback. This package does not implement unmounting or writes.

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

## Immutable OS artifact cache

The `@agent-boot/cli/images` API acquires only OS locks that exactly match the curated
`@agent-boot/os-adapters` catalog. Artifacts are keyed solely by their pinned SHA-256 digest.
HTTP redirects are rejected; interrupted downloads resume only after a valid `Content-Range`
response, and servers that ignore `Range` cause a safe full restart. A partial file is never
promoted to the final cache path until its pinned byte length and SHA-256 digest both match.

Every cache hit is reverified. Corrupt final entries are moved into the cache quarantine before
replacement, while checksum-mismatched downloads are discarded. Per-digest locks serialize
concurrent writers, and the final rename is atomic. The returned metadata distinguishes the XZ
container from the raw image and includes both compressed and decompressed byte lengths for later
device guardrails and streaming writers.

## Image customization transaction

The `@agent-boot/cli/customize` API handles the isolated post-write customization boundary; the
public end-to-end `image` command remains separate. It waits for an exact partition layout from the
immutable OS lock, creates mounts only beneath a private `0700` temporary root, and delegates every
assembly and bootstrap-secret write to the selected OS adapter. The Raspberry Pi adapter is mounted
with uniform root-only FAT permissions and per-entry ext4 permissions.

Every completed mount is unmounted in reverse order on success, failure, cancellation, or
`SIGHUP`/`SIGINT`/`SIGTERM`. Only after all mounts are gone does the transaction run `fsck.vfat -n`
and `e2fsck -f -n`; both read-only checks and the adapter postconditions must pass before success.
Routine tests inject partition, mount, ownership, adapter, and filesystem-check fakes and never
invoke a real device or privileged command.

# Agent Boot Image CLI

Agent Boot turns a reviewed, trusted TypeScript definition into guarded
Raspberry Pi boot media. The current release boundary is deliberately narrow:
Linux imaging hosts, Raspberry Pi 5, the pinned Raspberry Pi OS Lite ARM64
Trixie artifact, and the first Codex manual-device-auth vertical slice.

The definition runs as trusted executable code on the imaging host. Review the
definition and every import before using any command. Routine checks are
non-destructive; `image` is destructive after its explicit confirmation gate.

## Supported vertical slice

| Component | Supported value |
| --- | --- |
| Imaging host | Linux only |
| Target hardware | Raspberry Pi 5 |
| Target OS | Raspberry Pi OS Lite, Debian Trixie, ARM64 |
| Pinned image | `2026-06-18-raspios-trixie-arm64-lite.img.xz` |
| Provider | Codex `0.144.6`, manual device authentication |
| Target runtime | Private Node.js `v24.18.0` LTS ARM64 bundle |

See the [supported matrix](docs/supported-matrix.md) for exact artifact
identities, checksums, evidence boundaries, and explicit non-goals.

## Build and inspect

Node.js 24 or newer and npm are required.

```console
npm ci --ignore-scripts
npm run check
npm run build
npm test
```

Start from the maintained [public definition example](examples/definitive-agent/README.md),
then follow the [operator guide](docs/operator/README.md). The command sequence
is:

```console
create-agent validate --definition ./my-agent/definition.ts
create-agent synth --definition ./my-agent/definition.ts --output ./assembly --os-lock ./release/os-lock.json --runner-runtime ./release/node --runner-entrypoint ./release/runner.mjs
create-agent drives list
create-agent image --definition ./my-agent/definition.ts --runner-runtime ./release/node --runner-entrypoint ./release/runner.mjs --runner-bundle ./release/runner-bundle --cache-directory ./cache --lock-directory ./locks --target /dev/disk/by-id/usb-example-target --expect-model 'Example USB model' --expect-serial 'example-private-inventory-value' --expect-transport usb --max-size-bytes 137438953472
```

`validate` and `synth` do not read secret contents. `drives list` is read-only
orientation, not approval. `image` requires a stable whole-disk by-id target,
exact private inventory expectations, a redacted plan, acknowledgement, and a
final identity recheck under the target lock. Use `--dry-run` on `image` to
exercise definition, bundle, OS-lock, and synthesis preparation without
reading secrets, inspecting a target, downloading an image, or asking for
confirmation.

## Documentation

- [Operator guide](docs/operator/README.md): definitions, secrets, commands,
  target selection, first boot, and recovery.
- [Security model and limitations](docs/security.md): trust, credential,
  image, deletion, and host boundaries.
- [Supported matrix](docs/supported-matrix.md): the only advertised hardware,
  OS artifact, runtime, and provider slice.
- [Release checklist](docs/release-checklist.md): readiness decision, pinned
  inputs, CI, and open risks.
- [Root-spec traceability](docs/traceability.md): definition-of-done mapping to
  issues, tests, PRs, and physical evidence.
- [Architecture decisions](docs/architecture/README.md): package and threat
  boundaries.

Public examples under [`examples/`](examples/README.md) are maintained usage
material and contain fake illustrative values only. Canonical JSON and golden
trees under package or test fixture directories are internal conformance and
provenance data; they are not operator templates.

Generated images include a tty2 recovery login and the offline
`agent-boot-network` utility. See the [Wi-Fi recovery guide](docs/operator/network-reconfiguration.md).
Do not edit or delete runner checkpoints to force progress.

## Development safety

Routine CI does not download OS images, invoke privileged commands, mount
filesystems, or access block devices. The separate capacity integration accepts
only temporary sparse regular files and loop devices and remains opt-in:

```console
sudo env \
  AGENT_BOOT_CAPACITY_LOOP=1 \
  AGENT_BOOT_PINNED_IMAGE_XZ=/path/to/pinned.img.xz \
  AGENT_BOOT_ASSEMBLY_DIRECTORY=/path/to/assembly \
  AGENT_BOOT_RUNNER_BUNDLE_DIRECTORY=/path/to/bundle \
  npm run test:capacity-loop
```

It never accepts a physical-device path. Physical imaging and first boot require
the prerequisites and explicit human approval described in the operator guide.

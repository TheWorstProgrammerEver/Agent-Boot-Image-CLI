# Agent Boot Image CLI

Agent Boot is a Linux-hosted toolchain for describing an agent image in trusted
TypeScript, synthesizing that definition into a provider-neutral assembly, and
preparing a private runner for execution on the target image.

This repository currently contains foundation code only. The workspace modules
are intentionally inert while their contracts and implementations are delivered
in follow-up changes.

## Workspace

- `@agent-boot/assembly`: provider-neutral assembly protocol and runner contracts.
- `@agent-boot/definition`: trusted, host-side definition SDK.
- `@agent-boot/synth`: provider-neutral definition synthesizer.
- `@agent-boot/process`: shared process contracts and adapters.
- `@agent-boot/os-adapters`: curated OS locks and target-specific image customization.
- `@agent-boot/os-linux`: Linux imaging-host adapters.
- `@agent-boot/runner`: private on-image runtime.
- `@agent-boot/runner-bundle`: verified ARM64 Node/runtime and target systemd bundle.
- `@agent-boot/cli`: host-side composition root.

The enforced dependency graph and architecture decisions are documented in
[`docs/architecture/`](docs/architecture/README.md).

## Development

Node.js 24 or newer and npm are required.

```bash
npm ci --ignore-scripts
npm run check
npm run build
npm test
```

The boundary check can also be run independently:

```bash
npm run check:boundaries
```

Routine checks and CI are non-destructive. They do not download images, invoke
privileged commands, mount filesystems, or access block devices.

Generated images retain a tty2 recovery login and the offline `agent-boot-network` utility for
moving an already-imaged host to another Wi-Fi network. See the
[local Wi-Fi reconfiguration guide](docs/operator/network-reconfiguration.md).

The opt-in capacity integration uses only temporary sparse regular files and
loop devices. It requires root, a checksum-verified pinned image, a synthesized
assembly, and its verified runner bundle:

```bash
sudo env \
  AGENT_BOOT_CAPACITY_LOOP=1 \
  AGENT_BOOT_PINNED_IMAGE_XZ=/path/to/pinned.img.xz \
  AGENT_BOOT_ASSEMBLY_DIRECTORY=/path/to/assembly \
  AGENT_BOOT_RUNNER_BUNDLE_DIRECTORY=/path/to/bundle \
  npm run test:capacity-loop
```

The test never accepts a physical-device path from configuration. It creates
an exact-size image that must fail before planned files appear and an enlarged
sparse image that must provision root capacity and complete customization.

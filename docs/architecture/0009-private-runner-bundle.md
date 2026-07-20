# ADR 0009: Verified private runner bundle and console service

- Status: Accepted
- Date: 2026-07-20

## Context

The target runner must start before any sequence-installed Node or provider software exists. The OS
adapter also needs a reviewable placement contract without making bundle creation install a host
service or write to live system paths. Manual steps require the physical console, while ordinary
command output and failures must not become a journal or console secret channel.

## Decision

`@agent-boot/runner-bundle` produces an immutable adapter artifact with a `root/` directory that
mirrors target absolute paths and a canonical `manifest.json` outside that root. The manifest maps
each bundle path to its absolute target path and records kind, mode, file digest, Node provenance,
assembly/checkpoint compatibility, and an aggregate digest. Verification rescans the root and fails
closed on any entry, mode, digest, layout, architecture, or schema drift before adapter placement.

The Node input is a pinned extracted distribution. Bundle creation verifies the complete tree hash,
the LTS version/codename embedded in Node's installed header, and the ARM64 machine identifier in
the Node ELF executable. The upstream distribution digest remains in the manifest so the acquiring
adapter can connect the verified extracted tree to its immutable source artifact.

The target layout follows the root contract:

- `/opt/agent-boot` contains the private Node runtime, compiled runner packages, launchers, prompts,
  and assets;
- `/etc/agent-boot` contains the assembly manifest, runner plan, and temporary bootstrap inputs;
- `/var/lib/agent-boot` contains the durable checkpoint; and
- `/run/agent-boot` contains rendered prompts and ephemeral secret inputs.

The system service runs as the configured account, obtains `/dev/tty1` with `tty-force`, sets
`HOME`, `PATH`, and the working directory explicitly, and declares restart, stop, persistent-state,
runtime-state, and configuration-directory behavior. Progress is formatted from allowlisted
structured fields. Automatic, provider, completion-probe, and fire-and-forget output is drained and
discarded; only manual foreground commands inherit the TTY.

## Consequences

- The Raspberry Pi OS adapter places verified bundle entries but does not own runner internals.
- Bundle tests remain non-destructive and require neither downloads nor executable ARM64 emulation.
- A Node release change requires new immutable distribution and extracted-tree pins.
- A future console target, service manager, architecture, or compatibility version requires an
  explicit bundle-format change rather than implicit adapter behavior.

# `@agent-boot/runner-bundle`

This private package builds an adapter-ready target root for the on-image runner. It does not
install or start a host service, download Node, mount filesystems, or write to real system paths.
An OS adapter supplies an already acquired, immutable Node distribution and later places the
verified entries from the bundle manifest into its isolated target root.

The bundle has this shape:

```text
bundle/
  manifest.json
  root/
    opt/agent-boot/runtime/
    opt/agent-boot/scripts/
    opt/agent-boot/assets/
    opt/agent-boot/prompts/
    etc/agent-boot/bootstrap-secrets/
    etc/systemd/system/agent-boot-runner.service
    var/lib/agent-boot/
    run/agent-boot/prompts/
    run/agent-boot/secrets/
```

`buildRunnerBundle()` verifies the pinned runtime tree hash, the version and LTS codename embedded
in `include/node/node_version.h`, and the 64-bit little-endian ARM64 ELF machine identifier in
`bin/node`. Safe relative symlinks from the official Node distribution are retained. The resulting
manifest records every target path, kind, mode, file digest, compatibility version, Node source
digest, and a deterministic aggregate bundle digest. The source-distribution digest is provenance
for the acquiring adapter; the extracted tree digest verifies every byte that is actually shipped.

The systemd unit runs as the configured account with deliberate `HOME`, `PATH`, and working
directory values. It owns `/dev/tty1` with `StandardInput=tty-force`, routes allowlisted progress to
the journal and console, uses explicit restart and stop behavior, and asks systemd to create private
persistent and ephemeral state directories. Manual commands inherit the service TTY. Automatic,
provider, completion-probe, and fire-and-forget output is drained and discarded; only structured
runner progress reaches the unit output.

The runtime launcher reads `/etc/agent-boot/manifest.json` and `/etc/agent-boot/plan.json`, verifies
their shared agent identity, persists checkpoints at `/var/lib/agent-boot/state.json`, hydrates
secret-bearing prompts only beneath `/run/agent-boot`, and reconstructs the deterministic Codex
version/authentication gate before any provider prompt can execute. Fatal startup diagnostics are
constant text and never include caught exception content.

Routine tests use temporary roots and a tiny ARM64 ELF fixture. `systemd-analyze verify --root` is
used when available; no unit is installed or started.

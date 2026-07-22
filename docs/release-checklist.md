# Release-readiness checklist

Decision date: 2026-07-22

Decision: **ready for a limited first-vertical-slice release**, constrained to
the [supported matrix](supported-matrix.md). The release must carry the known
risks below and must not claim live service-restart recovery at the manual-auth
checkpoint.

## Schema and artifact compatibility

- [x] Definition, manifest, runner-plan, and OS-lock schema version `1` are
  validated by the same reviewed workspace revision.
- [x] The CLI rejects incompatible definition and assembly protocol versions.
- [x] The runner validates plan identity/version before resuming checkpoints.
- [x] The runner bundle manifest verifies its schema, complete tree, target
  paths, modes, Node release identity, ARM64 ELF entrypoint, service contract,
  and aggregate digest.
- [x] Public examples compile against the current SDK and validate/synthesize
  with synthetic operator inputs in CI.
- [x] Prompt variable declarations and `{{placeholder}}` uses fail closed during
  synthesis, before assembly publication or image write (RYA-197 / PR #31).

## Pinned release inputs

- [x] Raspberry Pi OS catalog ID, dated artifact URL, compressed byte length,
  raw byte length, partition contract, and SHA-256 are immutable and documented.
- [x] Private runtime is Node.js `v24.18.0` LTS ARM64 with recorded distribution
  and extracted-tree SHA-256 values.
- [x] Codex is pinned to exact version `0.144.6`; install, version, profile,
  permission, working-root, and authentication gates precede provider use.
- [x] The physical record includes the exact product baseline, OS lock,
  assembly ID, runner entry count, and bundle/artifact checksums without private
  device, network, path, or credential identifiers.

## Safety and operations

- [x] Trusted definition execution is prominently disclosed.
- [x] Stable target selection, whole-disk checks, active-root exclusion,
  topology resolution, private identity expectations, acknowledgement, lock,
  and immediate recheck are documented.
- [x] Image write uses verified input, exact byte counts, full read-back,
  customization, reverse unmount, read-only filesystem checks, and recovery
  classifications.
- [x] Secret guidance covers byte-exact files, mode `0600`, transactional
  installation, protected destinations, source removal, non-secure deletion,
  sensitive images, and revocable credentials.
- [x] Console/manual flow, tty2 recovery, Wi-Fi recovery, bounded service
  diagnostics, checkpoint preservation, and safe restart are documented.
- [x] Physical-test prerequisites require supported hardware, exact disposable
  stable-target approval, current topology, reviewed inputs, console access,
  and redacted evidence.

## Automated evidence

- [x] `npm run check` runs lint, strict TypeScript checks, example compilation,
  package-boundary checks, and the release-doc checker.
- [x] `npm test` runs unit, schema, guardrail, runner, example smoke, docs,
  redaction, prompt-mismatch, and cleanup coverage.
- [x] `npm run test:non-destructive` repeats deterministic synthesis and exercises
  guarded image orchestration, runner checkpoints, authored post-cognition,
  redaction, process cleanup, and device-access negative controls.
- [x] GitHub Actions runs `verify` and `non-destructive-integration` in a Node 24
  container with all capabilities dropped and `no-new-privileges`.
- [x] Routine validation does not download the OS artifact, mount filesystems,
  invoke privileged device commands, or access real block devices.

## Physical evidence

- [x] Exact raw write and full `2977955840`-byte read-back completed on an
  approved removable target.
- [x] Capacity provisioning, customization, independent FAT/ext4 checks, and
  clean unmount completed.
- [x] Raspberry Pi 5 first boot proved account/network bootstrap, private
  runtime/service start, tty1 progress, manual Codex device auth, pre-prompt
  permissions, prompt execution, secret-source cleanup, terminal health, and a
  post-success reboot without prompt replay.
- [x] RYA-193 / PR #32 proved definition-authored deterministic setup plus
  post-cognition ordering, failure/reboot recovery, deterministic verification,
  redaction, and cleanup with the current primitives.

## Open known risks

- [ ] RYA-195 has not yet performed a live stop/restart of
  `agent-boot-runner.service` while manual device authentication is pending.
  Simulated interruption and post-success physical reboot passed, but this
  transient live checkpoint is not part of the release claim.
- [ ] The physically validated baseline observed the distribution-owned
  `userconfig.service` fail after the product-owned account path had already
  succeeded. The Agent Boot runner was unaffected, but upstream image drift
  remains a reason to pin and revalidate every artifact.
- [ ] The offline Wi-Fi reconfiguration utility has automated isolated-root
  evidence but was merged after the physically booted product baseline. Treat it
  as a recovery aid, not additional physical-release evidence.
- [ ] Images and flash deletion provide no secure-erasure guarantee. Credential
  revocation remains an operator obligation.

Release owners should rerun the commands above from a clean checkout, confirm
hosted CI is green at the release commit, and update this decision if any pin,
schema, supported matrix entry, or open-risk claim changes.

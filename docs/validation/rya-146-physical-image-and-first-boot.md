# RYA-146 physical image and first-boot validation

Date: 2026-07-20

Issue: [RYA-146 - Run approved physical image and first-boot validation](https://linear.app/ryan-hayward/issue/RYA-146/agent-boot-run-approved-physical-image-and-first-boot-validation)

Result: **blocked during customization; first boot was not attempted.**

This record deliberately omits credentials, the approved target's unique
by-id value and serial, the network identity, the local operation path, and
secret-bearing output. The exact target approval remains in the human Linear
comment attached to RYA-146.

## Reviewed execution boundary

- Refreshed RYA-146, its comments, and dependency relations immediately before
  preparation and again at the destructive boundary.
- Confirmed RYA-143 and RYA-145 were `Done` at both refreshes.
- Confirmed the human comment named the exact whole-disk stable by-id target and
  explicitly declared that device disposable.
- Used repository commit `0d01ac6` from `main`.
- Kept the trusted deployment definition, Wi-Fi input, disposable initial
  password, one-time transaction marker, raw transcripts, cache, and recovery
  files in a mode-`0700` host-local operation tree. Secret files were mode
  `0600` and their values were never printed.
- Used a newly generated initial account password and transaction marker. The
  existing NetworkManager credential was transferred mechanically without
  entering logs or review artifacts.

## Pre-destructive validation

The clean repository baseline passed:

```text
npm ci --ignore-scripts
npm run check
npm test

tests 382
pass 382
fail 0
```

The ARM64 runner bundle was built from the checksum-verified Node distribution,
then verified independently through `verifyRunnerBundle()`. The complete image
command also passed `--dry-run`; dry-run reported that it accessed no secrets,
downloads, commands, devices, or output directories.

| Artifact | Verified identity |
| --- | --- |
| Assembly | `assembly-7cf0ba51e5992bae5b5dd73c139147ea` |
| OS lock | `raspberry-pi-os-lite-trixie-arm64-2026-06-18` |
| Raspberry Pi OS XZ SHA-256 | `acff736ca7945e3b305f07cda4abdb870910e12634991da69783611756e381b3` |
| Raspberry Pi OS raw byte length | `2,977,955,840` |
| Node version | `v24.18.0` LTS `Krypton` |
| Node distribution SHA-256 | `58c9520501f6ae2b52d5b210444e24b9d0c029a58c5011b797bc1fe7105886f6` |
| Node extracted-tree SHA-256 | `fe13f28dff3433d6dce353dd7f7da15f146cbca657fe55272c1de0b0b746aa68` |
| Runner bundle SHA-256 | `bfe43a84f28b9c19a979ad29ad2bdc4b4f7587c995ffe6b3b8e3eca2c351a976` |
| Runner bundle manifest file SHA-256 | `c34edcbd2e3f1a052e220fc4577e6c3ed24f32e05fc36499571bd679daf9b740` |
| Runner bundle entries | `5,911` |

## Device topology and guardrails

Before the write, the active root and boot filesystems were descendants of a
distinct 1 TB non-removable disk. The approved removable target was 128,320,801,792
bytes and had one mounted exFAT partition. That single partition was cleanly
unmounted before launch.

The immediate pre-write recheck proved:

- the approved by-id symlink still resolved to the same whole disk;
- the active root remained on the distinct system disk;
- the target was removable, USB-attached, writable, and within the explicit
  maximum size;
- the model and serial matched the explicit human-reviewed expectations;
- the target had zero mounted descendants; and
- no guardrail override was available or used.

The live CLI printed the redacted plan before acknowledgment and independently
confirmed model, serial, transport, removable state, size, active-root ancestry,
and mounted-descendant checks.

## Imaging result

The guarded live command ran in an inspectable detached systemd unit with a
separate state file and redacted transcript. It:

1. loaded and validated the trusted definition;
2. resolved the immutable curated OS lock;
3. verified runner artifacts and the complete runner bundle;
4. synthesized the same deterministic assembly as dry-run;
5. loaded bootstrap secrets into transient buffers;
6. downloaded and SHA-256-verified the pinned OS artifact;
7. printed and acknowledged the redacted destructive plan;
8. locked and rechecked the target identity;
9. wrote exactly `2,977,955,840` raw image bytes; and
10. completed full byte-for-byte read-back before entering customization.

The command then returned exit `12` with this bounded terminal result:

```text
Image failed during customize; recovery state: target-verified-needs-customization.
```

That recovery state is reached only after full read-back verification succeeds.
The workflow removed its private workspace, wiped its in-memory secret buffers,
released the device lock, and left the target unmounted.

## Preserved failure state

Post-failure topology showed the expected raw image partition table and no
mounted descendants:

| Partition | Size | Filesystem | Label |
| --- | ---: | --- | --- |
| Boot | 536,870,912 bytes | FAT32 | `bootfs` |
| Root | 2,432,696,320 bytes | ext4 | `rootfs` |

Independent read-only checks passed:

```text
fsck.vfat -n: exit 0
e2fsck -f -n: exit 0
```

A read-only inspection proved customization stopped before its first write:

- `/etc/agent-boot` was absent;
- the private runner service was absent and not enabled;
- `userconf`, `network-config`, and the SSH marker were absent from `bootfs`;
- the source image still had its expected UID/GID 1000 `pi` placeholder; and
- all inspection mounts were subsequently unmounted.

No first boot was attempted because the media contains only the verified base
OS, not the required account, network, private runner, or service customization.

## Root cause reproduction

To preserve the physical recovery state, diagnosis used a fresh decompressed
regular-file copy attached through a loop device. The same assembly, secrets,
OS lock, and verified runner bundle reproduced the failure before any adapter
write and exposed the underlying bounded error:

```text
RaspberryPiOsAdapterError
code: incompatible-image
message: The mounted root is not Raspberry Pi OS Trixie Lite.
```

The exact pinned official image contains these release markers:

```text
ID=debian
VERSION_ID=13
VERSION_CODENAME=trixie
```

The adapter currently requires `ID=raspbian`. Its curated catalog therefore
pins an official image that its own mounted-root identity check rejects.

Follow-up [RYA-184 - Align Trixie release identity with the pinned official image](https://linear.app/ryan-hayward/issue/RYA-184/agent-boot-align-trixie-release-identity-with-the-pinned-official)
owns the focused product and fixture correction. RYA-146 must remain blocked on
that issue; the preserved physical target must not be retried or booted as a
completed Agent Boot image in its current state.

## First-boot validation matrix

All first-boot claims remain unproven because the prerequisite customization
did not complete:

| Required proof | Result |
| --- | --- |
| Account and network bootstrap | Not run |
| Private runtime and service start | Not run |
| Console progress | Not run |
| Environment inheritance | Not run |
| Manual Codex device authentication | Not run |
| Pre-prompt YOLO gates | Not run |
| Prompt execution | Not run |
| Secret transaction cleanup | Not run |
| Interruption and reboot recovery | Not run |
| Final health/failure observability | Imaging failure observed; boot health not run |

After RYA-184 is resolved, resume RYA-146 by refreshing the exact approval and
dependencies, rebuilding all artifacts from reviewed `main`, repeating the
entire guarded image transaction, and then executing the first-boot matrix.

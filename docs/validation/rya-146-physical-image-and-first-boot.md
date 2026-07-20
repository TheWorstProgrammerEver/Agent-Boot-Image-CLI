# RYA-146 physical image and first-boot validation

Date: 2026-07-20

Issue: [RYA-146 - Run approved physical image and first-boot validation](https://linear.app/ryan-hayward/issue/RYA-146/agent-boot-run-approved-physical-image-and-first-boot-validation)

Result: **physical imaging complete; first-boot validation awaits the
human-assisted hardware and manual device-auth step.**

This record deliberately omits credentials, the approved target's unique
by-id value and serial, the network identity, the local operation path, and
secret-bearing output. The exact target approval remains in the human Linear
comment attached to RYA-146.

## Reviewed execution boundary

- Refreshed RYA-146, its comments, and dependency relations immediately before
  preparation and again at the destructive boundary.
- Confirmed RYA-143 and RYA-145 were `Done` before the first attempt. Confirmed
  RYA-143, RYA-145, and the first-attempt blocker RYA-184 were `Done` before the
  second attempt. Confirmed RYA-143, RYA-145, RYA-184, and the second-attempt
  blocker RYA-186 were `Done` before the successful third attempt.
- Confirmed the human comment named the exact whole-disk stable by-id target and
  explicitly declared that device disposable.
- The first attempt used repository commit `0d01ac6` from `main`. The second
  attempt used product baseline `120197b`, after the RYA-184 correction merged.
  The successful third attempt used product baseline `3d10420`, after the
  independently reviewed RYA-186 capacity correction merged.
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

tests 406
pass 405
fail 0
skipped 1 (the explicitly opt-in capacity loop test)
```

The four-test guarded non-destructive integration suite also passed.

Before each rerun, the ARM64 runner bundle was freshly rebuilt from the
checksum-verified Node distribution, then verified independently through
`verifyRunnerBundle()`. The complete image command also passed `--dry-run`;
dry-run reported that it accessed no secrets, downloads, commands, devices, or
output directories.

| Artifact | Verified identity |
| --- | --- |
| Assembly | `assembly-7cf0ba51e5992bae5b5dd73c139147ea` |
| OS lock | `raspberry-pi-os-lite-trixie-arm64-2026-06-18` |
| Raspberry Pi OS XZ SHA-256 | `acff736ca7945e3b305f07cda4abdb870910e12634991da69783611756e381b3` |
| Raspberry Pi OS raw byte length | `2,977,955,840` |
| Node version | `v24.18.0` LTS `Krypton` |
| Node distribution SHA-256 | `58c9520501f6ae2b52d5b210444e24b9d0c029a58c5011b797bc1fe7105886f6` |
| Node extracted-tree SHA-256 | `fe13f28dff3433d6dce353dd7f7da15f146cbca657fe55272c1de0b0b746aa68` |
| Runner bundle SHA-256 | `3c4dd5efa0c347f43b49cf12692ebfd5f85257b0ec2a9487d8d0671a8820ed40` |
| Runner bundle manifest file SHA-256 | `a51677afc4aae5d57bf5a62aaffff671a2423bb914d2f109afcfa7201ee0d554` |
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

## Imaging attempts

All three guarded live commands ran in inspectable detached systemd units with
a separate state file and redacted transcript. Each:

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

The first attempt returned exit `12` because the adapter expected
`ID=raspbian`, while the pinned official image identifies itself as Debian
Trixie. RYA-184 corrected that contract and passed independent loop-image
validation before it merged.

The approved rerun repeated the entire transaction from the reviewed product
baseline and again returned exit `12` with this bounded terminal result:

```text
Image failed during customize; recovery state: target-verified-needs-customization.
```

That recovery state is reached only after full read-back verification succeeds.
The workflow removed its private workspace, wiped its in-memory secret buffers,
released the device lock, and left the target unmounted.

After RYA-186 merged, the approved third attempt repeated the complete workflow
from product baseline `3d10420`. It again verified the immutable OS artifact,
passed every live target guardrail without an override, wrote exactly
`2,977,955,840` bytes, and completed the full byte-for-byte read-back. The
guarded transaction then expanded only the verified final ext4 root to the
larger physical target, revalidated the locked partition topology, completed
the entire customization plan, passed both read-only filesystem checks, and
cleanly unmounted the target. The command exited `0` with recovery state
`complete`.

The final partition sizes were:

| Partition | Size | Filesystem | Label |
| --- | ---: | --- | --- |
| Boot | 536,870,912 bytes | FAT32 | `bootfs` |
| Root | 127,775,542,272 bytes | ext4 | `rootfs` |

Independent post-command `fsck.vfat -n` and `e2fsck -f -n` checks passed. A
read-only inspection confirmed the account and network first-boot inputs, SSH
marker, immutable assembly, private runtime, enabled runner service, workspace,
and the sole runner-consumed bootstrap secret source without reading any
secret-bearing content. The two customization-only secrets were absent from
the runner source directory as designed. The ext4 root retained 30,141,524
free 4 KiB blocks and the target again had zero mounted descendants.

## Preserved rerun failure state

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

A read-only inspection proved the rerun stopped in a partial customization
state. The private runtime, service file, manifest, plan, one of three bootstrap
secret source files, and network configuration were present. Service enablement,
account bootstrap, the SSH marker, the other two secret source files, and prompt
output were absent. No secret contents were read. The root filesystem reported
zero generally available bytes, and all inspection mounts were subsequently
unmounted.

No first boot was attempted from that failed state because the media was
internally inconsistent and did not satisfy the adapter's final postconditions.

## Root cause reproductions

To preserve the physical recovery state after the first attempt, diagnosis used
a fresh decompressed regular-file copy attached through a loop device. The same
assembly, secrets, OS lock, and verified runner bundle reproduced the identity
failure before any adapter write:

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

Follow-up [RYA-184 - Align Trixie release identity with the pinned official image](https://linear.app/ryan-hayward/issue/RYA-184/agent-boot-align-trixie-release-identity-with-the-pinned-official)
corrected that mismatch.

After the rerun, another fresh regular-file copy was decompressed from the
checksum-verified artifact, a fresh assembly was synthesized, and the corrected
adapter was invoked through a loop device. It independently failed with:

```text
Error
code: ENOSPC
message: ENOSPC: no space left on device, write
```

The pinned root filesystem has 593,920 4 KiB blocks, of which 80,860 were free
before customization. The verified runner bundle contains 5,911 entries and
uses about 211 MB of allocated source storage before filesystem metadata and the
rest of the customization plan. The failed physical root retained only 4,097
free blocks, all reserved from ordinary use, after the partial write.

Follow-up [RYA-186 - Provision and preflight filesystem capacity before customization](https://linear.app/ryan-hayward/issue/RYA-186/agent-boot-provision-and-preflight-filesystem-capacity-before)
implemented complete cross-root capacity preflight before mutation and safe
root-capacity provisioning on larger targets. Its independently reviewed merge
was the baseline for the successful third physical attempt described above.

## First-boot validation matrix

All first-boot claims remain pending until the human-assisted hardware boot and
manual device-auth step:

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
| Final health/failure observability | Imaging success and both earlier failures were bounded and inspectable; boot health not run |

Resume by booting the cleanly unmounted media on supported Raspberry Pi 5
hardware with a human available at tty1 for the manual Codex device-auth step,
then execute the interruption, reboot, secret-cleanup, prompt, and final-health
assertions without copying device codes or credential-bearing output.

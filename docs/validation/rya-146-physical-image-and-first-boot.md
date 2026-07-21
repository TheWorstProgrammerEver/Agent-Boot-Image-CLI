# RYA-146 physical image and first-boot validation

Date: 2026-07-21

Issue: [RYA-146 - Run approved physical image and first-boot validation](https://linear.app/ryan-hayward/issue/RYA-146/agent-boot-run-approved-physical-image-and-first-boot-validation)

Result: **fresh physical imaging passed from the reviewed merged baseline;
first-boot validation awaits the required human-assisted hardware boot and
manual device-auth step.**

This record deliberately omits credentials, the approved target's stable
identifier and serial, the network identity, private operation paths, and
secret-bearing output. The exact whole-disk approval and disposable-device
confirmation remain in the human Linear comment attached to RYA-146.

## Reviewed execution boundary

- Refreshed RYA-146, its complete comments, and every dependency immediately
  before preparation and again at the destructive boundary.
- Confirmed RYA-188, RYA-186, RYA-184, RYA-143, and RYA-145 were all `Done`.
- Used only merged commit
  `77103c27695319036cb9e42143d70d3987ff8479`, the independently reviewed
  RYA-188 baseline explicitly permitted by the reviewer comment.
- Started from a fresh evidence branch based directly on that commit. The
  rejected mixed evidence/product branch was preserved but was not used.
- Kept the trusted definition, Wi-Fi input, disposable initial password,
  one-time transaction marker, cache, raw transcript, topology, and recovery
  state in a mode-`0700` host-local operation tree. Secret inputs remained
  mode `0600` and their values were never printed.

An initial operator-side topology assertion used `lsblk --raw` for the model
field and therefore compared the escaped space form rather than the literal
model. It failed closed before unmount or write. The assertion was corrected to
use the non-raw model field, then the complete boundary was rerun.

## Pre-destructive validation

The clean merged baseline passed:

```text
npm ci --ignore-scripts
npm run check
npm test

tests 406
pass 405
fail 0
skipped 1 (the explicitly opt-in regular-file/loop capacity test)
```

The four-test guarded non-destructive integration suite also passed. It proved
the device guard, deterministic end-to-end assembly/runner simulation,
redacted failure diagnostics, descendant-process cleanup, and reboot recovery
without physical I/O.

The ARM64 runner bundle was freshly rebuilt from the checksum-verified Node
distribution and independently re-read through `verifyRunnerBundle()` before
the dry run or live command.

| Artifact | Verified identity |
| --- | --- |
| Product baseline | `77103c27695319036cb9e42143d70d3987ff8479` |
| Assembly | `assembly-3c222b87a62f2b8f8ca71ce8f084b84a` |
| OS lock | `raspberry-pi-os-lite-trixie-arm64-2026-06-18` |
| Raspberry Pi OS XZ SHA-256 | `acff736ca7945e3b305f07cda4abdb870910e12634991da69783611756e381b3` |
| Raspberry Pi OS raw byte length | `2,977,955,840` |
| Node version | `v24.18.0` LTS `Krypton` |
| Node distribution SHA-256 | `58c9520501f6ae2b52d5b210444e24b9d0c029a58c5011b797bc1fe7105886f6` |
| Node extracted-tree SHA-256 | `fe13f28dff3433d6dce353dd7f7da15f146cbca657fe55272c1de0b0b746aa68` |
| Runner bundle SHA-256 | `ef443d58a3457d06dd9f7d5fde05d549eb0c7649591e2ca36e6f37c8129ec5e4` |
| Runner manifest-file SHA-256 | `6cf73430a07befb3539c5353137ab0284ec920e8955f9c27645244227139f353` |
| Runner bundle entries | `5,911` |

The complete `image --dry-run` reproduced the assembly above and reported that
it accessed no secret, download, command, device, or output-directory boundary.

## Device topology and guardrails

Before unmount, the active root and boot filesystems were descendants of a
distinct non-removable system disk. The approved target was a removable,
USB-attached 128,320,801,792-byte whole disk with two desktop-automounted
partitions from the preceding diagnostic boot.

Only those two verified target descendants were unmounted. The immediate
pre-launch recheck then proved:

- the exact approved stable target still resolved to the same whole disk;
- the active root remained on the distinct system disk;
- target type, transport, removable state, model, serial, and size matched the
  explicit constraints;
- the target was writable and below the explicit maximum size;
- the target had zero mounted descendants; and
- no guardrail override was available or used.

The live CLI independently repeated these checks under its device-lock boundary
and printed only a redacted target plan.

## Physical transaction result

The complete command ran in a detached, inspectable systemd unit with private
state and a redacted transcript. It:

1. loaded and validated the trusted definition;
2. resolved the immutable curated OS lock;
3. verified runner artifacts and all 5,911 bundle entries;
4. synthesized the same deterministic assembly as the dry run;
5. loaded bootstrap secrets only into transient buffers;
6. SHA-256-verified the cached immutable OS artifact;
7. printed and acknowledged the redacted destructive plan;
8. locked and rechecked the target identity and topology;
9. wrote exactly `2,977,955,840` raw image bytes;
10. completed full byte-for-byte read-back verification;
11. expanded only the verified final ext4 root to the larger media;
12. revalidated the locked partition topology;
13. applied the complete cross-root customization plan;
14. passed FAT and ext4 read-only filesystem checks; and
15. removed its private workspace, wiped transient secret buffers, released the
    device lock, and left zero mounted descendants.

The command exited `0` with recovery state `complete` and the bounded terminal
summary:

```text
Image complete: assembly assembly-3c222b87a62f2b8f8ca71ce8f084b84a;
OS lock raspberry-pi-os-lite-trixie-arm64-2026-06-18;
2977955840 target bytes read-back verified; 2 filesystem checks passed.
```

## Independent post-image checks

| Partition | Size | Filesystem | Label |
| --- | ---: | --- | --- |
| Boot | 536,870,912 bytes | FAT32 | `bootfs` |
| Root | 127,775,542,272 bytes | ext4 | `rootfs` |

Independent `fsck.vfat -n` and `e2fsck -f -n` checks passed after the CLI had
unmounted the target. The ext4 root reported 31,195,136 total 4 KiB blocks,
30,141,518 free blocks, and 7,369,270 free inodes.

A separate read-only inspection, followed by clean reverse unmount, proved:

- all four first-user boot inputs for account, network, and SSH bootstrap were
  present without reading credential-bearing contents;
- NetworkManager state explicitly enabled networking, wireless, and WWAN;
- the private ARM64 Node runtime and runner entrypoint were executable;
- the root-owned runner unit was enabled and bound progress to tty1 plus the
  journal;
- the unit waited for first-user setup, network-online, and SSH, with start
  limiting disabled;
- the account-local npm prefix and both service and interactive-shell PATH
  inheritance files were present with account ownership;
- the root-owned manifest and plan, account-traversable configuration
  directory, workspace, and immutable assembly were present;
- exactly one account-owned mode-`0600` runner-consumed bootstrap secret source
  remained, as required before first boot; and
- the plan contained the ordered environment, Codex install/version/profile,
  manual device-auth, reboot-probe, secret transaction, bootstrap-mode exit,
  prompt-render, and provider-execution steps.

No secret source content, account password hash, network credential, device-auth
code, or generated credential output was read or copied. Final inspection left
zero mounted descendants.

## First-boot validation matrix

No first-boot claim is made from offline image evidence.

| Required proof | Result |
| --- | --- |
| Account and network bootstrap | Prepared and inspected offline; hardware boot pending |
| Private runtime and service start | Prepared and inspected offline; hardware boot pending |
| Console progress | tty1/journal routing inspected offline; observation pending |
| Environment inheritance | Service and shell inputs inspected offline; live proof pending |
| Manual Codex device authentication | Pending required human interaction |
| Pre-prompt YOLO gates | Ordered plan/profile inputs inspected offline; live proof pending |
| Prompt execution | Ordered plan and expected safe output inspected; live proof pending |
| Secret transaction cleanup | Sole runner source present pre-boot as required; cleanup pending |
| Interruption and reboot recovery | Non-destructive simulation passed; physical proof pending |
| Final health/failure observability | Imaging success is bounded and inspectable; boot health pending |

Resume by booting this cleanly unmounted media on supported Raspberry Pi 5
hardware with tty1 visible. During the manual auth checkpoint, perform one
controlled runner interruption/restart to prove checkpoint resume without
replaying completed bootstrap work. Complete device auth without recording the
device code, allow terminal prompt success, then reboot once and verify terminal
state persistence, service/journal observability, prompt output, ephemeral
cleanup, and zero remaining bootstrap-secret sources.

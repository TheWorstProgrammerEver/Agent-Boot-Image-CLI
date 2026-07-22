# RYA-146 physical image and first-boot validation

Date: 2026-07-21

Issue: [RYA-146 - Run approved physical image and first-boot validation](https://linear.app/ryan-hayward/issue/RYA-146/agent-boot-run-approved-physical-image-and-first-boot-validation)

Result: **fresh physical imaging, first boot, manual Codex device auth, prompt
execution, secret-source cleanup, and post-success reboot validation passed
from the reviewed merged baseline.**

This record deliberately omits credentials, the approved target's stable
identifier and serial, the network identity, private operation paths, and
secret-bearing output. The exact whole-disk approval and disposable-device
confirmation remain in the human Linear comment attached to RYA-146.

## Reviewed execution boundary

- Refreshed RYA-146, its complete comments, and every dependency immediately
  before preparation and again at the destructive boundary.
- Confirmed RYA-189, RYA-188, RYA-186, RYA-184, RYA-143, and RYA-145 were all
  `Done`.
- Used only merged commit
  `3c173b256de35637a3f91f41d13cca29a7f2a3e5`, the independently reviewed
  RYA-189 merge whose tree is identical to reviewed PR head `8daf4a8`.
- Rebased the evidence-only branch directly onto that pinned commit. A later,
  unrelated `main` advance was deliberately excluded from this transaction.
- Kept the trusted definition, Wi-Fi input, disposable initial password,
  one-time transaction marker, cache, raw transcript, topology, and recovery
  state in a mode-`0700` host-local operation tree. Secret inputs remained
  mode `0600` and their values were never printed.

An initial operator-side size assertion lacked the host's required read
privilege. It failed closed before the imaging unit was created and before any
media write. The probe was corrected to use the existing non-interactive root
boundary, then approval, dependencies, and topology were all refreshed again.

## Pre-destructive validation

The clean merged baseline passed:

```text
npm ci --ignore-scripts
npm run check
npm test

tests 408
pass 407
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
| Product baseline | `3c173b256de35637a3f91f41d13cca29a7f2a3e5` |
| Assembly | `assembly-3c222b87a62f2b8f8ca71ce8f084b84a` |
| OS lock | `raspberry-pi-os-lite-trixie-arm64-2026-06-18` |
| Raspberry Pi OS XZ SHA-256 | `acff736ca7945e3b305f07cda4abdb870910e12634991da69783611756e381b3` |
| Raspberry Pi OS raw byte length | `2,977,955,840` |
| Node version | `v24.18.0` LTS `Krypton` |
| Node distribution SHA-256 | `58c9520501f6ae2b52d5b210444e24b9d0c029a58c5011b797bc1fe7105886f6` |
| Node extracted-tree SHA-256 | `fe13f28dff3433d6dce353dd7f7da15f146cbca657fe55272c1de0b0b746aa68` |
| Runner bundle SHA-256 | `e9ac00bd3c2887701fb0906211a81888bc6c01f66b18260008db45f84e2bfad3` |
| Runner manifest-file SHA-256 | `ea3f4062233a4c76f51332f5deebbd4ed8f4529cfec1d3483254c03c359e869a` |
| Runner bundle entries | `5,911` |

The complete `image --dry-run` reproduced the assembly above and reported that
it accessed no secret, download, command, device, or output-directory boundary.

## Device topology and guardrails

The active root and boot filesystems were descendants of a distinct
non-removable system disk. The approved target was a removable, USB-attached
128,320,801,792-byte whole disk whose two partitions already had zero mounted
descendants. The immediate pre-launch recheck then proved:

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
30,141,513 free blocks, and 7,369,264 free inodes.

A separate read-only inspection, followed by clean reverse unmount, proved:

- all three first-user boot inputs for account, network, and SSH bootstrap were
  present without reading credential-bearing contents;
- NetworkManager state explicitly enabled networking, wireless, and WWAN, and
  the native root-owned mode-`0600` autoconnect profile was present without
  reading its credential-bearing contents;
- the private ARM64 Node runtime and runner entrypoint were executable;
- the root-owned runner unit was enabled, bound progress to tty1 plus the
  journal, and did not depend on `network-online.target`;
- the unit waited for first-user setup, NetworkManager, and SSH, with start
  limiting disabled;
- tty1 getty was masked for deterministic runner ownership, tty2 recovery login
  was enabled, and bounded persistent journaling was configured;
- the account-local npm prefix and both service and interactive-shell PATH
  inheritance files were present with account ownership;
- the root-owned manifest and plan, account-traversable configuration
  directory, workspace, and immutable assembly were present;
- exactly one account-owned mode-`0600` runner-consumed bootstrap secret source
  remained, as required before first boot; and
- the plan contained the ordered environment, Codex install/version/profile,
  manual device-auth, reboot-probe, secret transaction, bootstrap-mode exit,
  prompt-render, and provider-execution steps; and
- the installed verified runtime contained the exact pre-prompt
  `approval_policy = "never"` and `sandbox_mode = "danger-full-access"` gates.

No secret source content, account password hash, network credential, device-auth
code, or generated credential output was read or copied. Final inspection left
zero mounted descendants.

## Live first-boot and reboot validation

The operator booted the prepared media on supported Raspberry Pi 5 hardware on
2026-07-21 and completed the required manual Codex device-auth flow without
recording the device code or credential-bearing output.

The normal Raspberry Pi OS `userconfig.service` failed during boot, but the
product-owned runner was unaffected. The configured first user already existed,
SSH became available, and `agent-boot-runner.service` continued through the
ordered plan. The runner journal then proved:

- Codex install, exact-version verification, profile configuration, and profile
  verification all succeeded before authentication.
- The manual `codex-authenticate-device` gate waited, retried, detected manual
  completion, and then succeeded.
- The reboot probe, transaction marker installation, bootstrap-mode exit,
  validation-prompt render, and validation-prompt execution all succeeded.
- The runner reached terminal `runner-succeeded` and systemd reported
  `ExecStart=/opt/agent-boot/scripts/bin/agent-boot-runner
  (code=exited, status=0/SUCCESS)`.

The safe validation output was present with the expected content:

```text
agent-boot physical validation passed
```

After the operator rebooted the Pi, SSH returned. The post-success service run
started, emitted only `runner-starting`, and deactivated successfully in under
one second with exit status `0`. The terminal validation output still existed,
`/etc/agent-boot/bootstrap-secrets` contained zero files, and
`/var/lib/agent-boot` retained the runner state plus bounded service-status
file.

## First-boot validation matrix

| Required proof | Result |
| --- | --- |
| Account and network bootstrap | Passed on supported Raspberry Pi 5 hardware; SSH returned before and after terminal success |
| Private runtime and service start | Passed; systemd started the private runner and observed successful exit |
| Console progress | Passed through live operator observation and persistent journal output |
| Environment inheritance | Passed through ordered Codex install/version/profile/auth steps and successful prompt execution |
| Manual Codex device authentication | Passed after manual device-auth completion; no device code recorded |
| Pre-prompt YOLO gates | Passed; checked-in plan/profile inputs plus live ordered gates completed before prompt execution |
| Prompt execution | Passed; expected safe validation output was written |
| Secret transaction cleanup | Passed; bootstrap secret source was removed and the source directory contained zero files |
| Interruption and reboot recovery | Passed for post-success physical reboot; earlier checkpoint recovery remains covered by the non-destructive integration suite |
| Final health/failure observability | Passed; persistent service/journal state, terminal runner state, safe output, and cleanup state were observable after reboot |

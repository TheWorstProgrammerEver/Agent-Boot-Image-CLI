# `@agent-boot/os-adapters`

This package owns curated operating-system artifact selection. It resolves a validated catalog
selection to the provider-neutral `os-lock.json` protocol without downloading the artifact,
consulting upstream release listings, or invoking host commands.

The initial catalog intentionally contains one supported vertical slice:

- Raspberry Pi OS Lite, Debian Trixie, ARM64
- 18 June 2026 image from the dated Raspberry Pi archive
- Raspberry Pi 5 only
- `bootfs` FAT32 and `rootfs` ext4 partition expectations

The artifact digest and release metadata are pinned from the official
[Raspberry Pi OS downloads](https://www.raspberrypi.com/software/operating-systems/) page. The
catalog also records the artifact's dated archive URL, exact byte length, and immutable checksum
sidecar URL. Being listed upstream does not make another release or board supported here.

Future operating-system implementations, such as DietPi, can add entries and adapter modules at
this boundary while continuing to emit the existing `@agent-boot/protocol` OS lock.

## Raspberry Pi OS Trixie customization

`@agent-boot/os-adapters/raspberry-pi-os-trixie` accepts already-mounted partition roots through a
small discovery interface. It first validates the complete immutable catalog lock, including the
pinned archive digest, then validates the mounted `bootfs`/`rootfs` shape before writing. The exact
2026-06-18 artifact reports `ID=debian`, `VERSION_ID=13`, and `VERSION_CODENAME=trixie`; Raspberry
Pi provenance is established independently by the exact dated `/etc/rpi-issue` marker plus Pi 5
device-tree, kernel, config, and command-line markers on `bootfs`. Mounting, image orchestration, and
real-device selection remain outside the adapter.

The adapter verifies the assembly and private ARM64 runner bundle, then installs their immutable
assets, target placements, plan, manifest, bootstrap-secret inputs, account-owned state paths, and
the enabled console service with explicit modes and ownership. Raspberry Pi first-user and SSH
bootstrap use `/boot/firmware/userconf` and `/boot/firmware/ssh`; headless Wi-Fi uses cloud-init's
Netplan v2 `/boot/firmware/network-config` seed with the NetworkManager renderer. Account password
hashing uses deliberate stdin through an injected command host, and repeat customization reuses the
existing SHA-512 crypt salt so the image remains byte-stable.

Because FAT32 cannot store per-file POSIX ownership or mode bits, the mounted `bootfs` contract is
uniform root ownership with directories exposed as `0700` and files as `0600`. Image orchestration
must mount it with equivalent `uid=0,gid=0,fmask=0177,dmask=0077` options and report those
capabilities to the adapter. The adapter rejects a weaker mount before writing and persists the same
options in `/etc/fstab`, keeping the plaintext one-time Wi-Fi seed inaccessible to non-root Linux
users. This is operating-system access control, not encryption against someone reading the physical
media.

`PosixImageOwnership` applies numeric ownership for privileged image customization. Tests inject
fixture ownership, partition discovery, and command adapters, so they never mount an image, touch a
device, change a host account or network, or start a service. Returned post-customization assertions
contain only stable assertion identifiers and target paths; they never contain SSIDs, passphrases,
passwords, secret bytes, or credential fingerprints.

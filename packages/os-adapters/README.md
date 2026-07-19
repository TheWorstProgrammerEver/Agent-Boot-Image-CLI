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

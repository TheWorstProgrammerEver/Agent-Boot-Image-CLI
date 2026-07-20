# ADR 0010: Raspberry Pi OS Trixie customization boundary

- Status: Accepted
- Date: 2026-07-20

## Context

The curated Raspberry Pi OS Lite ARM64 Trixie image needs release-specific first-boot configuration
and a concrete target layout. Generic image orchestration will acquire, mount, and later unmount an
image, but it must not duplicate knowledge of Raspberry Pi partition labels, cloud-init seed paths,
account bootstrap markers, or console service wiring.

Customization handles credential-bearing local inputs and privileged target paths. It must reject a
wrong image or unsafe source before making an otherwise valid root look partially customized, while
routine tests must remain independent of mounts, devices, host accounts, networks, and services.

## Decision

`@agent-boot/os-adapters/raspberry-pi-os-trixie` accepts already-mounted partitions through an
injected discovery contract. Before writing, it verifies the exact curated OS lock, `bootfs` FAT32
and `rootfs` ext4 labels, canonical Trixie release metadata, every declared assembly asset and
prompt, the complete runner-bundle manifest, the runner service account, and all existing target
path components. Both partition plans are preflighted before either plan is applied.

The discovery contract also reports filesystem metadata capabilities. The ext4 root must support
per-entry POSIX metadata. FAT32 cannot, so `bootfs` must instead be mounted with uniform root
ownership, directory mode `0700`, and file mode `0600`; a weaker mount is rejected before any seed
is written. The adapter persists equivalent `uid=0,gid=0,fmask=0177,dmask=0077` options in
`/etc/fstab` before it writes the boot seed. This limits Linux access to root but does not encrypt
the removable media.

The adapter uses Raspberry Pi OS Trixie first-boot mechanisms:

- `/boot/firmware/userconf` contains the first username and a SHA-512 crypt hash produced through
  deliberate command stdin;
- `/boot/firmware/ssh` enables the packaged SSH service; and
- `/boot/firmware/network-config` contains a Netplan v2 cloud-init seed for NetworkManager.

The release-specific account contract accepts the curated `pi` UID/GID 1000 placeholder, which
`userconf-pi` renames at first boot, or the already-renamed requested account for idempotent
customization. It rejects other UID/GID occupants, target-name collisions, and usernames outside
Trixie's `^[a-z][a-z0-9-]*$` grammar.

The verified bundle is placed at its manifest target paths. Immutable assembly prompts and assets
remain below `/opt/agent-boot`; explicit system and user-home placements are also materialized. The
manifest and runner plan live below `/etc/agent-boot`, runner-needed bootstrap secrets are
account-owned mode `0600`, and the console service is enabled through the multi-user target. Root
and first-user numeric ownership are explicit parts of the adapter contract.

Post-customization verification rereads every planned kind, link target, effective mode, owner, and
file byte. On FAT32, effective mode and ownership are verified against the uniform mount contract;
on ext4, they are verified per entry.
The returned assertion records contain only allowlisted identifiers and public target paths. They do
not contain secret values, SSIDs, hashes, or credential fingerprints.

## Consequences

- Mount lifecycle, real-device access, and generic orchestration remain outside this adapter.
- The initial slice deliberately supports only the curated Raspberry Pi 5 ARM64 Trixie lock and
  first user identity `1000:1000`; another release or board needs a separate reviewed contract.
- Tests can use real temporary trees with fake partition discovery, ownership, and command hosts.
- Password hashing can be byte-stable on repeat by reusing the existing managed crypt salt without
  storing plaintext outside deliberate command stdin.

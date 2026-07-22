# Supported matrix

This matrix is the complete advertised release boundary as of 2026-07-22.
Anything not listed is unsupported, even if an adapter boundary or typed
descriptor could represent it.

| Boundary | Supported value | Evidence |
| --- | --- | --- |
| Imaging host | Linux; Node.js 24+ for the workspace | Architecture ADR and CI |
| Target board | Raspberry Pi 5 (`raspberry-pi-5`) | Fresh physical boot |
| Target architecture | ARM64 | Catalog, private runtime verification, physical boot |
| Target OS | Raspberry Pi OS Lite; Debian 13 Trixie identity | Pinned catalog and mounted-image checks |
| Catalog ID | `raspberry-pi-os-lite-trixie-arm64` | Catalog schema and resolver tests |
| OS lock | `raspberry-pi-os-lite-trixie-arm64-2026-06-18` | Physical image record |
| Image artifact | `2026-06-18-raspios-trixie-arm64-lite.img.xz` | Immutable catalog |
| Compressed bytes | `524875608` | Catalog validation |
| Artifact SHA-256 | `acff736ca7945e3b305f07cda4abdb870910e12634991da69783611756e381b3` | Catalog and physical acquisition |
| Raw image bytes | `2977955840` | XZ inspection and full physical read-back |
| Partitions | FAT32 `bootfs`; ext4 `rootfs` | Adapter and post-image checks |
| Target runtime | Node.js `v24.18.0` LTS `Krypton`, ARM64 | Bundle and physical runtime checks |
| Node distribution SHA-256 | `58c9520501f6ae2b52d5b210444e24b9d0c029a58c5011b797bc1fe7105886f6` | Physical bundle record |
| Node extracted-tree SHA-256 | `fe13f28dff3433d6dce353dd7f7da15f146cbca657fe55272c1de0b0b746aa68` | Physical bundle record |
| Provider | Codex `0.144.6` | Definition pin, runtime gates, physical auth and prompt |
| Authentication | Manual device auth on tty1 | Physical first boot |
| Permission profile | `sandbox_mode = "danger-full-access"`; `approval_policy = "never"` | Pre-prompt gate and physical evidence |
| Definition recipe | Ordered deterministic steps plus authored `renderPrompt()` / `runProvider()` cognition | RYA-193 and non-destructive recipe test |

The checked-in OS catalog is the source of truth for artifact identity and has
exactly one entry. [`test/docs-release.test.mjs`](../test/docs-release.test.mjs)
compares this page with the built catalog so documentation cannot silently add
an OS, board, or artifact claim.

## Not advertised

- macOS or Windows imaging hosts;
- Raspberry Pi models other than Raspberry Pi 5;
- other Raspberry Pi OS dates, architectures, or variants;
- DietPi or another adapter placeholder;
- Codex versions other than `0.144.6`;
- automatic Codex credential bootstrap as a physically validated path;
- other cognition providers; or
- live recovery from a service restart during the pending manual-auth console
  checkpoint. That evidence remains tracked by RYA-195.

The [physical validation record](validation/rya-146-physical-image-and-first-boot.md)
is evidence for this exact slice, not a general compatibility claim.

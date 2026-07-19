import type { OsCatalogEntry } from "./schema.js";

export const RASPBERRY_PI_OS_LITE_TRIXIE_ARM64: OsCatalogEntry = {
  catalogId: "raspberry-pi-os-lite-trixie-arm64",
  lockId: "raspberry-pi-os-lite-trixie-arm64-2026-06-18",
  publishedAt: "2026-06-18",
  operatingSystem: {
    family: "raspberry-pi-os",
    release: "debian-trixie",
    variant: "lite",
    architecture: "arm64",
  },
  artifact: {
    identity: "2026-06-18-raspios-trixie-arm64-lite.img.xz",
    url: "https://downloads.raspberrypi.com/raspios_lite_arm64/images/raspios_lite_arm64-2026-06-19/2026-06-18-raspios-trixie-arm64-lite.img.xz",
    byteLength: 524_875_608,
    checksum: {
      algorithm: "sha256",
      digest: "acff736ca7945e3b305f07cda4abdb870910e12634991da69783611756e381b3",
      sourceUrl: "https://downloads.raspberrypi.com/raspios_lite_arm64/images/raspios_lite_arm64-2026-06-19/2026-06-18-raspios-trixie-arm64-lite.img.xz.sha256",
    },
  },
  supportedBoards: ["raspberry-pi-5"],
  partitions: [
    { role: "boot", filesystem: "fat32", label: "bootfs" },
    { role: "root", filesystem: "ext4", label: "rootfs" },
  ],
};

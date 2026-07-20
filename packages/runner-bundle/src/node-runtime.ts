import { open, readFile } from "node:fs/promises";
import { join } from "node:path";

import { isSha256 } from "./digest.js";
import type { NodeRuntimePin } from "./model.js";
import { inspectTree, treeSha256, type TreeRecord } from "./tree.js";

const AARCH64_ELF_MACHINE = 183;

const headerValue = (header: string, name: string): string | undefined =>
  new RegExp(`^#define ${name} (.+)$`, "mu").exec(header)?.[1];

const embeddedVersion = (header: string): { lts: string; version: string } => {
  const major = headerValue(header, "NODE_MAJOR_VERSION");
  const minor = headerValue(header, "NODE_MINOR_VERSION");
  const patch = headerValue(header, "NODE_PATCH_VERSION");
  const isLts = headerValue(header, "NODE_VERSION_IS_LTS");
  const codename = headerValue(header, "NODE_VERSION_LTS_CODENAME")?.replaceAll('"', "");
  if (
    major === undefined || minor === undefined || patch === undefined ||
    isLts !== "1" || codename === undefined || codename.length === 0
  ) {
    throw new Error("Node runtime metadata does not identify an LTS release.");
  }
  return { lts: codename, version: `v${major}.${minor}.${patch}` };
};

const assertArm64Elf = async (nodePath: string): Promise<void> => {
  const handle = await open(nodePath, "r");
  try {
    const header = Buffer.alloc(20);
    const { bytesRead } = await handle.read(header, 0, header.length, 0);
    if (
      bytesRead !== header.length ||
      !header.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])) ||
      header[4] !== 2 ||
      header[5] !== 1 ||
      header.readUInt16LE(18) !== AARCH64_ELF_MACHINE
    ) {
      throw new Error("Node executable must be a 64-bit little-endian ARM64 ELF binary.");
    }
  } finally {
    await handle.close();
  }
};

export const verifyNodeRuntime = async (
  runtimeDirectory: string,
  pin: NodeRuntimePin,
): Promise<readonly TreeRecord[]> => {
  if (!isSha256(pin.distributionSha256) || !isSha256(pin.treeSha256)) {
    throw new Error("Node runtime checksums must be lowercase SHA-256 values.");
  }
  await assertArm64Elf(join(runtimeDirectory, "bin", "node"));
  const header = await readFile(
    join(runtimeDirectory, "include", "node", "node_version.h"),
    "utf8",
  );
  const embedded = embeddedVersion(header);
  if (embedded.version !== pin.version || embedded.lts !== pin.ltsCodename) {
    throw new Error("Node runtime version or LTS metadata does not match its pinned metadata.");
  }
  const records = await inspectTree(runtimeDirectory);
  if (treeSha256(records) !== pin.treeSha256) {
    throw new Error("Node runtime tree checksum does not match its pinned metadata.");
  }
  return records;
};

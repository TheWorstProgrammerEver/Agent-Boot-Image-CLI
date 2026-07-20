import { statfs } from "node:fs/promises";

import { RaspberryPiOsCapacityError } from "./errors.js";
import type { ImagePlanEntry } from "./filesystem.js";
import type {
  ImagePlanCapacity,
  MountedFilesystemCapacity,
  MountedFilesystemCapacityInspector,
} from "./model.js";

const allocationOverheadPercent = 25n;
// Reserve both per-entry allocation/metadata above and a fixed journal/slack budget.
const fixedSafetyBytes = 64n * 1_024n * 1_024n;
const inodeSafetyCount = 256n;
const bytesPerProvisionedInode = 16_384n;

const divideRoundUp = (value: bigint, divisor: bigint): bigint =>
  (value + divisor - 1n) / divisor;

const entryDataBlocks = (entry: ImagePlanEntry, blockSize: bigint): bigint => {
  if (entry.kind === "file") {
    return entry.contents.byteLength === 0
      ? 1n
      : divideRoundUp(BigInt(entry.contents.byteLength), blockSize);
  }
  if (entry.kind === "symlink") {
    return divideRoundUp(BigInt(Buffer.byteLength(entry.linkTarget, "utf8")), blockSize) || 1n;
  }
  return 1n;
};

export const calculateImagePlanCapacity = (
  entries: readonly ImagePlanEntry[],
  blockSize: bigint,
): ImagePlanCapacity => {
  if (blockSize <= 0n) throw new RangeError("Filesystem block size must be positive.");
  const allocationBlocks = entries.reduce(
    (total, entry) => total + entryDataBlocks(entry, blockSize) + 1n,
    0n,
  );
  const requiredBlocks = divideRoundUp(
    allocationBlocks * (100n + allocationOverheadPercent),
    100n,
  ) + divideRoundUp(fixedSafetyBytes, blockSize);
  const entryCount = BigInt(entries.length);
  const requiredInodes = divideRoundUp(
    entryCount * (100n + allocationOverheadPercent),
    100n,
  ) + inodeSafetyCount;
  return { requiredBlocks, requiredInodes };
};

export class SystemMountedFilesystemCapacityInspector implements MountedFilesystemCapacityInspector {
  async inspect(path: string): Promise<MountedFilesystemCapacity> {
    const snapshot = await statfs(path, { bigint: true });
    return {
      availableBlocks: snapshot.bavail,
      blockSize: snapshot.bsize,
      freeInodes: snapshot.ffree,
      totalInodes: snapshot.files,
    };
  }
}

export const preflightImagePlanCapacity = async (
  role: string,
  root: string,
  entries: readonly ImagePlanEntry[],
  inspector: MountedFilesystemCapacityInspector,
): Promise<ImagePlanCapacity> => {
  const available = await inspector.inspect(root);
  if (
    available.blockSize <= 0n || available.availableBlocks < 0n ||
    available.freeInodes < 0n || available.totalInodes < 0n
  ) throw new RangeError("Filesystem capacity values must be non-negative.");
  const required = calculateImagePlanCapacity(entries, available.blockSize);
  const missingBlocks = required.requiredBlocks > available.availableBlocks
    ? required.requiredBlocks - available.availableBlocks
    : 0n;
  const missingInodes = available.totalInodes > 0n && required.requiredInodes > available.freeInodes
    ? required.requiredInodes - available.freeInodes
    : 0n;
  if (missingBlocks > 0n || missingInodes > 0n) {
    throw new RaspberryPiOsCapacityError(role, {
      availableBlocks: available.availableBlocks,
      availableInodes: available.freeInodes,
      blockSize: available.blockSize,
      requiredAdditionalBytes: missingBlocks * available.blockSize > missingInodes * bytesPerProvisionedInode
        ? missingBlocks * available.blockSize
        : missingInodes * bytesPerProvisionedInode,
      requiredBlocks: required.requiredBlocks,
      requiredInodes: required.requiredInodes,
    });
  }
  return required;
};

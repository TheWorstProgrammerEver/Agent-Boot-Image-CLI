import type { OsLock } from "@agent-boot/protocol";

import { adapterError } from "./errors.js";
import type { MountedImagePartition, MountedPartitionDiscovery } from "./model.js";
import { assertSafeRoot, readSafeFile } from "./source.js";

export interface ValidatedImageRoots {
  readonly boot: string;
  readonly root: string;
}

const exactPartition = (
  actual: MountedImagePartition,
  expected: OsLock["partitions"][number],
): boolean =>
  actual.role === expected.role &&
  actual.filesystem === expected.filesystem &&
  actual.label === expected.label;

const parseOsRelease = (contents: Uint8Array): ReadonlyMap<string, string> => {
  const values = new Map<string, string>();
  for (const line of Buffer.from(contents).toString("utf8").split("\n")) {
    const separator = line.indexOf("=");
    if (separator <= 0) continue;
    const key = line.slice(0, separator);
    const raw = line.slice(separator + 1);
    values.set(key, raw.replace(/^"|"$/gu, ""));
  }
  return values;
};

const assertImageShape = async (roots: ValidatedImageRoots): Promise<void> => {
  const [config, commandLine, osRelease, passwd, group] = await Promise.all([
    readSafeFile(roots.boot, "config.txt"),
    readSafeFile(roots.boot, "cmdline.txt"),
    readSafeFile(roots.root, "usr/lib/os-release"),
    readSafeFile(roots.root, "etc/passwd"),
    readSafeFile(roots.root, "etc/group"),
  ]);
  const release = parseOsRelease(osRelease);
  if (
    config.byteLength === 0 || commandLine.byteLength === 0 || passwd.byteLength === 0 ||
    group.byteLength === 0 || release.get("ID") !== "raspbian" ||
    release.get("VERSION_CODENAME") !== "trixie" || release.get("VERSION_ID") !== "13"
  ) throw adapterError("incompatible-image", "The mounted root is not Raspberry Pi OS Trixie Lite.");
};

export const discoverImageRoots = async (
  discovery: MountedPartitionDiscovery,
  osLock: OsLock,
): Promise<ValidatedImageRoots> => {
  let partitions: readonly MountedImagePartition[];
  try {
    partitions = await discovery.discover();
  } catch {
    throw adapterError("incompatible-image", "Image partition discovery failed.");
  }
  if (
    partitions.length !== osLock.partitions.length ||
    osLock.partitions.some((expected) => {
      const matching = partitions.filter((partition) => partition.role === expected.role);
      return matching.length !== 1 || matching[0] === undefined || !exactPartition(matching[0], expected);
    })
  ) throw adapterError("incompatible-image", "Image partitions do not match the catalog contract.");

  const boot = partitions.find((partition) => partition.role === "boot");
  const root = partitions.find((partition) => partition.role === "root");
  if (boot === undefined || root === undefined || boot.mountPath === root.mountPath) {
    throw adapterError("incompatible-image", "Image partitions do not provide distinct boot and root mounts.");
  }
  const roots = {
    boot: await assertSafeRoot(boot.mountPath),
    root: await assertSafeRoot(root.mountPath),
  };
  await assertImageShape(roots);
  return roots;
};

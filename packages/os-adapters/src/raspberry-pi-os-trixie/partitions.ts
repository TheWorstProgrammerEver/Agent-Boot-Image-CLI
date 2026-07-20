import type { OsLock } from "@agent-boot/protocol";

import { adapterError } from "./errors.js";
import type {
  ImageFilesystemMetadata,
  MountedImagePartition,
  MountedPartitionDiscovery,
} from "./model.js";
import { RASPBERRY_PI_OS_LITE_TRIXIE_MOUNTED_IDENTITY } from "../catalog/raspberry-pi-os.js";
import { assertSafeRoot, readSafeFile } from "./source.js";

export interface ValidatedImageRoots {
  readonly boot: ValidatedImageRoot;
  readonly root: ValidatedImageRoot;
}

export interface ValidatedImageRoot {
  readonly metadata: ImageFilesystemMetadata;
  readonly path: string;
}

const rootIdentity = { gid: 0, uid: 0 } as const;

const exactMetadataContract = (partition: MountedImagePartition): boolean => {
  if (partition.role === "root") return partition.metadata.kind === "per-entry";
  return partition.role === "boot" && partition.metadata.kind === "uniform" &&
    partition.metadata.directoryMode === 0o700 && partition.metadata.fileMode === 0o600 &&
    partition.metadata.identity.uid === rootIdentity.uid &&
    partition.metadata.identity.gid === rootIdentity.gid;
};

const exactPartition = (
  actual: MountedImagePartition,
  expected: OsLock["partitions"][number],
): boolean =>
  actual.role === expected.role &&
  actual.filesystem === expected.filesystem &&
  actual.label === expected.label &&
  exactMetadataContract(actual);

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

const normalizedLines = (contents: Uint8Array): ReadonlySet<string> =>
  new Set(Buffer.from(contents).toString("utf8").split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#")));

const commandLineTokens = (contents: Uint8Array): ReadonlySet<string> =>
  new Set(Buffer.from(contents).toString("utf8").trim().split(/\s+/u));

const assertImageShape = async (roots: ValidatedImageRoots): Promise<void> => {
  const identity = RASPBERRY_PI_OS_LITE_TRIXIE_MOUNTED_IDENTITY;
  const [config, commandLine, osRelease, raspberryPiIssue, passwd, group, ...bootFiles] =
    await Promise.all([
    readSafeFile(roots.boot.path, "config.txt"),
    readSafeFile(roots.boot.path, "cmdline.txt"),
    readSafeFile(roots.root.path, "usr/lib/os-release"),
    readSafeFile(roots.root.path, "etc/rpi-issue"),
    readSafeFile(roots.root.path, "etc/passwd"),
    readSafeFile(roots.root.path, "etc/group"),
    ...identity.boot.requiredFiles.map((path) => readSafeFile(roots.boot.path, path)),
  ]);
  const release = parseOsRelease(osRelease);
  const configValues = normalizedLines(config);
  const commandLineValues = commandLineTokens(commandLine);
  if (
    config.byteLength === 0 || commandLine.byteLength === 0 || passwd.byteLength === 0 ||
    group.byteLength === 0 || bootFiles.some((file) => file.byteLength === 0) ||
    release.get("ID") !== identity.osRelease.id ||
    release.get("VERSION_CODENAME") !== identity.osRelease.versionCodename ||
    release.get("VERSION_ID") !== identity.osRelease.versionId ||
    Buffer.from(raspberryPiIssue).toString("utf8") !== identity.raspberryPiIssue ||
    identity.boot.configLines.some((line) => !configValues.has(line)) ||
    identity.boot.commandLineTokens.some((token) => !commandLineValues.has(token))
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
    boot: { metadata: boot.metadata, path: await assertSafeRoot(boot.mountPath) },
    root: { metadata: root.metadata, path: await assertSafeRoot(root.mountPath) },
  };
  await assertImageShape(roots);
  return roots;
};

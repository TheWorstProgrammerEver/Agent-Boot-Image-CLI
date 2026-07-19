import { osCatalog } from "@agent-boot/os-adapters/catalog";
import { osLockSchema, type OsLock } from "@agent-boot/protocol";

import { ArtifactAcquisitionError } from "./errors.js";

const reject = (): never => {
  throw new ArtifactAcquisitionError("unpinned-lock");
};

export const resolveCatalogArtifact = (input: unknown): OsLock => {
  let lock: OsLock;
  try {
    lock = osLockSchema.parse(input);
  } catch {
    return reject();
  }

  const entry = osCatalog.entries.find(({ lockId }) => lockId === lock.catalogId);
  if (entry === undefined) return reject();

  const expected = osCatalog.resolve({
    architecture: entry.operatingSystem.architecture,
    boards: entry.supportedBoards,
    catalogId: entry.catalogId,
  });
  if (JSON.stringify(lock) !== JSON.stringify(expected)) return reject();
  if (!expected.artifact.url.endsWith(".img.xz")) return reject();
  return osLockSchema.parse(expected);
};

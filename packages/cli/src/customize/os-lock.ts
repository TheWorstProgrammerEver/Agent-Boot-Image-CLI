import { osCatalog } from "@agent-boot/os-adapters/catalog";
import { osLockSchema, type OsLock } from "@agent-boot/protocol";

import { customizationError } from "./errors.js";

export const resolveCustomizationOsLock = (input: unknown): OsLock => {
  let lock: OsLock;
  try {
    lock = osLockSchema.parse(input);
  } catch {
    throw customizationError("invalid-input");
  }

  const entry = osCatalog.entries.find(({ lockId }) => lockId === lock.catalogId);
  if (entry === undefined) throw customizationError("invalid-input");
  const expected = osCatalog.resolve({
    architecture: entry.operatingSystem.architecture,
    boards: entry.supportedBoards,
    catalogId: entry.catalogId,
  });
  if (JSON.stringify(lock) !== JSON.stringify(expected)) throw customizationError("invalid-input");
  return osLockSchema.parse(expected);
};

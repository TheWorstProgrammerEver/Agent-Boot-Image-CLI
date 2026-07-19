import { constants } from "node:fs";

import type {
  UserSecretFileHandle,
  UserSecretFileSystem,
} from "./filesystem.js";

export const errorCode = (error: unknown): string | undefined =>
  typeof (error as NodeJS.ErrnoException).code === "string"
    ? (error as NodeJS.ErrnoException).code
    : undefined;

export const closeQuietly = async (
  handle: UserSecretFileHandle | undefined,
): Promise<void> => {
  try {
    await handle?.close();
  } catch {
    // Preserve the operation failure that triggered cleanup.
  }
};

export const syncDirectory = async (
  fileSystem: UserSecretFileSystem,
  path: string,
): Promise<void> => {
  const handle = await fileSystem.open(
    path,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
};

export const unlinkIfPresent = async (
  fileSystem: UserSecretFileSystem,
  path: string,
): Promise<void> => {
  try {
    await fileSystem.unlink(path);
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
  }
};

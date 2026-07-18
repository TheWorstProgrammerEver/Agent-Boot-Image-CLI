import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { basename, dirname, join } from "node:path";

import type { StateFileHandle, StateFileSystem } from "./filesystem.js";

export type CheckpointDirectoryInspection =
  | { readonly status: "absent" }
  | { readonly status: "valid" }
  | { readonly diagnostic: string; readonly status: "corrupt" }
  | { readonly mode: number; readonly status: "unsafe-permissions" }
  | {
      readonly actualOwner: number;
      readonly expectedOwner: number;
      readonly status: "unsafe-owner";
    };

const errorCode = (error: unknown): string | undefined =>
  typeof (error as NodeJS.ErrnoException).code === "string"
    ? (error as NodeJS.ErrnoException).code
    : undefined;

const closeQuietly = async (handle: StateFileHandle | undefined): Promise<void> => {
  try {
    await handle?.close();
  } catch {
    // Preserve the persistence error that triggered cleanup.
  }
};

const unlinkIfPresent = async (fileSystem: StateFileSystem, path: string): Promise<void> => {
  try {
    await fileSystem.unlink(path);
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
  }
};

export const inspectCheckpointDirectory = async (
  fileSystem: StateFileSystem,
  path: string,
  expectedOwner: number,
): Promise<CheckpointDirectoryInspection> => {
  let stat;
  try {
    stat = await fileSystem.lstat(dirname(path));
  } catch (error) {
    if (errorCode(error) === "ENOENT") return { status: "absent" };
    throw error;
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    return { diagnostic: "state directory path is not a directory", status: "corrupt" };
  }
  const mode = stat.mode & 0o777;
  if ((mode & 0o022) !== 0) return { mode, status: "unsafe-permissions" };
  return stat.uid === expectedOwner
    ? { status: "valid" }
    : { actualOwner: stat.uid, expectedOwner, status: "unsafe-owner" };
};

const requireTrustedCheckpointDirectory = async (
  fileSystem: StateFileSystem,
  path: string,
  expectedOwner: number,
): Promise<void> => {
  const inspection = await inspectCheckpointDirectory(fileSystem, path, expectedOwner);
  if (inspection.status !== "valid") {
    throw new Error(`checkpoint directory is ${inspection.status}`);
  }
};

export const syncDirectory = async (
  fileSystem: StateFileSystem,
  directory: string,
): Promise<void> => {
  const handle = await fileSystem.open(directory, constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
};

const tempPrefixFor = (path: string): string => `.${basename(path)}.`;

export const cleanupCheckpointTemps = async (
  fileSystem: StateFileSystem,
  path: string,
): Promise<void> => {
  const directory = dirname(path);
  let names: string[];
  try {
    names = await fileSystem.readdir(directory);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return;
    throw error;
  }

  const prefix = tempPrefixFor(path);
  const temps = names.filter((name) => name.startsWith(prefix) && name.endsWith(".tmp"));
  await Promise.all(temps.map((name) => unlinkIfPresent(fileSystem, join(directory, name))));
  // This also completes durability after a prior process observed rename success but was
  // interrupted before its directory sync. Re-inspection is therefore a safe idempotent retry.
  await syncDirectory(fileSystem, directory);
};

export const writeFileAtomically = async (
  fileSystem: StateFileSystem,
  path: string,
  contents: string,
  expectedOwner: number,
): Promise<void> => {
  const directory = dirname(path);
  await fileSystem.mkdir(directory, { mode: 0o700, recursive: true });
  await requireTrustedCheckpointDirectory(fileSystem, path, expectedOwner);
  const temporaryPath = join(
    directory,
    `${tempPrefixFor(path)}${String(process.pid)}.${randomUUID()}.tmp`,
  );
  let handle: StateFileHandle | undefined;
  let renamed = false;

  try {
    handle = await fileSystem.open(
      temporaryPath,
      constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW | constants.O_WRONLY,
      0o600,
    );
    await handle.writeFile(contents);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await fileSystem.rename(temporaryPath, path);
    renamed = true;
    await syncDirectory(fileSystem, directory);
  } catch (error) {
    await closeQuietly(handle);
    if (!renamed) await unlinkIfPresent(fileSystem, temporaryPath);
    throw error;
  }
};

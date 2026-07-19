import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { basename, dirname, join, relative } from "node:path";

import { UserSecretInstallError } from "./errors.js";
import type {
  UserSecretFileHandle,
  UserSecretFileStat,
  UserSecretFileSystem,
  UserSecretOwnership,
} from "./filesystem.js";
import {
  closeQuietly,
  errorCode,
  syncDirectory,
  unlinkIfPresent,
} from "./io.js";
import { containedDestination } from "./paths.js";

const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;

const sameBytes = (left: Uint8Array, right: Uint8Array): boolean =>
  left.byteLength === right.byteLength && left.every((value, index) => value === right[index]);

export class UserSecretDestinationStore {
  readonly #accountGid: number;
  readonly #accountHome: string;
  readonly #accountUid: number;
  readonly #fileSystem: UserSecretFileSystem;
  readonly #ownership: UserSecretOwnership;

  constructor(
    fileSystem: UserSecretFileSystem,
    ownership: UserSecretOwnership,
    accountHome: string,
    accountUid: number,
    accountGid: number,
  ) {
    this.#accountGid = accountGid;
    this.#accountHome = accountHome;
    this.#accountUid = accountUid;
    this.#fileSystem = fileSystem;
    this.#ownership = ownership;
  }

  async pathFor(destination: string): Promise<{ readonly home: string; readonly path: string }> {
    let home;
    try {
      home = await this.#fileSystem.realpath(this.#accountHome);
    } catch (error) {
      throw new UserSecretInstallError("unsafe-destination", { cause: error });
    }
    const status = await this.#lstat(home, "unsafe-destination");
    if (!status.isDirectory() || status.isSymbolicLink()) {
      throw new UserSecretInstallError("unsafe-destination");
    }
    return { home, path: containedDestination(home, destination) };
  }

  async install(home: string, destination: string, contents: Uint8Array): Promise<void> {
    await this.#prepareDirectories(home, dirname(destination));
    await this.#cleanupTemps(destination);
    const temporary = join(
      dirname(destination),
      `.${basename(destination)}.${randomUUID()}.tmp`,
    );
    let handle: UserSecretFileHandle | undefined;
    let renamed = false;
    try {
      handle = await this.#fileSystem.open(
        temporary,
        constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW | constants.O_WRONLY,
        PRIVATE_FILE_MODE,
      );
      await handle.writeFile(contents);
      await handle.sync();
      await handle.close();
      handle = undefined;
      await this.#ownership.set(temporary, this.#accountUid, this.#accountGid);
      await this.#fileSystem.chmod(temporary, PRIVATE_FILE_MODE);
      handle = await this.#fileSystem.open(temporary, constants.O_RDONLY | constants.O_NOFOLLOW);
      await handle.sync();
      await handle.close();
      handle = undefined;
      await this.#fileSystem.rename(temporary, destination);
      renamed = true;
      await syncDirectory(this.#fileSystem, dirname(destination));
    } catch (error) {
      await closeQuietly(handle);
      if (!renamed) await unlinkIfPresent(this.#fileSystem, temporary);
      throw new UserSecretInstallError("install-failed", { cause: error });
    }
  }

  async verify(path: string, expected?: Uint8Array): Promise<void> {
    let handle: UserSecretFileHandle | undefined;
    try {
      handle = await this.#fileSystem.open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      this.#requireFileStatus(await handle.stat());
      if (expected !== undefined && !sameBytes(await handle.readFile(), expected)) {
        throw new UserSecretInstallError("verification-failed");
      }
    } catch (error) {
      if (error instanceof UserSecretInstallError) throw error;
      throw new UserSecretInstallError("verification-failed", { cause: error });
    } finally {
      await closeQuietly(handle);
    }
  }

  async #cleanupTemps(destination: string): Promise<void> {
    const directory = dirname(destination);
    const prefix = `.${basename(destination)}.`;
    let removed = false;
    try {
      for (const name of await this.#fileSystem.readdir(directory)) {
        if (!name.startsWith(prefix) || !name.endsWith(".tmp")) continue;
        await unlinkIfPresent(this.#fileSystem, join(directory, name));
        removed = true;
      }
      if (removed) await syncDirectory(this.#fileSystem, directory);
    } catch (error) {
      throw new UserSecretInstallError("install-failed", { cause: error });
    }
  }

  async #prepareDirectories(home: string, target: string): Promise<void> {
    const segments = relative(home, target).split("/").filter(Boolean);
    let current = home;
    for (const segment of segments) {
      const parent = current;
      current = join(current, segment);
      try {
        await this.#fileSystem.mkdir(current, { mode: PRIVATE_DIRECTORY_MODE });
        await syncDirectory(this.#fileSystem, parent);
      } catch (error) {
        if (errorCode(error) !== "EEXIST") {
          throw new UserSecretInstallError("install-failed", { cause: error });
        }
      }
      const status = await this.#lstat(current, "unsafe-destination");
      if (!status.isDirectory() || status.isSymbolicLink()) {
        throw new UserSecretInstallError("unsafe-destination");
      }
      try {
        await this.#ownership.set(current, this.#accountUid, this.#accountGid);
        await this.#fileSystem.chmod(current, PRIVATE_DIRECTORY_MODE);
        await syncDirectory(this.#fileSystem, current);
      } catch (error) {
        throw new UserSecretInstallError("install-failed", { cause: error });
      }
      await this.#verifyDirectory(current);
    }
  }

  async #verifyDirectory(path: string): Promise<void> {
    const status = await this.#lstat(path, "verification-failed");
    if (
      !status.isDirectory() ||
      status.isSymbolicLink() ||
      status.uid !== this.#accountUid ||
      status.gid !== this.#accountGid ||
      (status.mode & 0o777) !== PRIVATE_DIRECTORY_MODE
    ) {
      throw new UserSecretInstallError("verification-failed");
    }
  }

  #requireFileStatus(status: UserSecretFileStat): void {
    if (
      !status.isFile() ||
      status.isSymbolicLink() ||
      status.nlink !== 1 ||
      status.uid !== this.#accountUid ||
      status.gid !== this.#accountGid ||
      (status.mode & 0o777) !== PRIVATE_FILE_MODE
    ) {
      throw new UserSecretInstallError("verification-failed");
    }
  }

  async #lstat(
    path: string,
    code: "unsafe-destination" | "verification-failed",
  ): Promise<UserSecretFileStat> {
    try {
      return await this.#fileSystem.lstat(path);
    } catch (error) {
      throw new UserSecretInstallError(code, { cause: error });
    }
  }
}

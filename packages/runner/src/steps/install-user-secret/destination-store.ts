import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { relative } from "node:path";

import { UserSecretInstallError } from "./errors.js";
import type {
  UserSecretFileHandle,
  UserSecretFileStat,
  UserSecretFileSystem,
  UserSecretOwnership,
} from "./filesystem.js";
import { closeQuietly, errorCode, unlinkAtIfPresent } from "./io.js";
import { containedDestination } from "./paths.js";

const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const UUID_V4 = "[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";

interface DestinationLocation {
  readonly directorySegments: readonly string[];
  readonly fileName: string;
  readonly home: string;
}

const sameBytes = (left: Uint8Array, right: Uint8Array): boolean =>
  left.byteLength === right.byteLength && left.every((value, index) => value === right[index]);

const escaped = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");

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

  async pathFor(destination: string): Promise<DestinationLocation> {
    let home;
    try {
      home = await this.#fileSystem.realpath(this.#accountHome);
    } catch (error) {
      throw new UserSecretInstallError("unsafe-destination", { cause: error });
    }
    const path = containedDestination(home, destination);
    const segments = relative(home, path).split("/");
    const fileName = segments.pop();
    if (fileName === undefined) throw new UserSecretInstallError("unsafe-destination");
    await closeQuietly(await this.#openHome(home));
    return {
      directorySegments: segments,
      fileName,
      home,
    };
  }

  async install(destination: DestinationLocation, contents: Uint8Array): Promise<void> {
    let directory: UserSecretFileHandle | undefined;
    let temporary: string | undefined;
    let temporaryHandle: UserSecretFileHandle | undefined;
    let renamed = false;
    try {
      directory = await this.#openDirectory(destination, true);
      await this.#cleanupTemps(directory, destination.fileName);
      temporary = `.${destination.fileName}.${randomUUID()}.tmp`;
      temporaryHandle = await this.#fileSystem.openAt(
        directory,
        temporary,
        constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW | constants.O_WRONLY,
        PRIVATE_FILE_MODE,
      );
      await temporaryHandle.writeFile(contents);
      await temporaryHandle.sync();
      await this.#ownership.set(temporaryHandle, this.#accountUid, this.#accountGid);
      await temporaryHandle.chmod(PRIVATE_FILE_MODE);
      this.#requireFileStatus(await temporaryHandle.stat());
      await temporaryHandle.sync();
      await this.#fileSystem.renameAt(directory, temporary, destination.fileName);
      renamed = true;
      await directory.sync();
    } catch (error) {
      if (!renamed && directory !== undefined && temporary !== undefined) {
        await unlinkAtIfPresent(this.#fileSystem, directory, temporary);
      }
      throw new UserSecretInstallError("install-failed", { cause: error });
    } finally {
      await closeQuietly(temporaryHandle);
      await closeQuietly(directory);
    }
  }

  async verify(destination: DestinationLocation, expected?: Uint8Array): Promise<void> {
    let directory: UserSecretFileHandle | undefined;
    let handle: UserSecretFileHandle | undefined;
    try {
      directory = await this.#openDirectory(destination, false);
      handle = await this.#fileSystem.openAt(
        directory,
        destination.fileName,
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
      this.#requireFileStatus(await handle.stat());
      if (expected !== undefined && !sameBytes(await handle.readFile(), expected)) {
        throw new UserSecretInstallError("verification-failed");
      }
    } catch (error) {
      if (error instanceof UserSecretInstallError) throw error;
      throw new UserSecretInstallError("verification-failed", { cause: error });
    } finally {
      await closeQuietly(handle);
      await closeQuietly(directory);
    }
  }

  async #cleanupTemps(directory: UserSecretFileHandle, fileName: string): Promise<void> {
    const temporaryName = new RegExp(`^\\.${escaped(fileName)}\\.${UUID_V4}\\.tmp$`, "u");
    let removed = false;
    try {
      for (const name of await this.#fileSystem.readdirAt(directory)) {
        if (!temporaryName.test(name)) continue;
        const status = await this.#fileSystem.lstatAt(directory, name);
        if (
          !status.isFile() ||
          status.isSymbolicLink() ||
          status.nlink !== 1 ||
          (status.mode & 0o077) !== 0
        ) {
          continue;
        }
        await unlinkAtIfPresent(this.#fileSystem, directory, name);
        removed = true;
      }
      if (removed) await directory.sync();
    } catch (error) {
      throw new UserSecretInstallError("install-failed", { cause: error });
    }
  }

  async #openDirectory(
    destination: DestinationLocation,
    create: boolean,
  ): Promise<UserSecretFileHandle> {
    let current = await this.#openHome(destination.home);
    try {
      for (const segment of destination.directorySegments) {
        if (create) {
          try {
            await this.#fileSystem.mkdirAt(current, segment, { mode: PRIVATE_DIRECTORY_MODE });
            await current.sync();
          } catch (error) {
            if (errorCode(error) !== "EEXIST") throw error;
          }
        }
        const child = await this.#fileSystem.openAt(
          current,
          segment,
          constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
        );
        if (create) {
          await this.#ownership.set(child, this.#accountUid, this.#accountGid);
          await child.chmod(PRIVATE_DIRECTORY_MODE);
          await child.sync();
        }
        this.#requireDirectoryStatus(await child.stat());
        await current.close();
        current = child;
      }
      return current;
    } catch (error) {
      await closeQuietly(current);
      if (error instanceof UserSecretInstallError) throw error;
      throw new UserSecretInstallError(create ? "install-failed" : "verification-failed", {
        cause: error,
      });
    }
  }

  async #openHome(path: string): Promise<UserSecretFileHandle> {
    let handle: UserSecretFileHandle | undefined;
    try {
      const before = await this.#fileSystem.lstat(path);
      handle = await this.#fileSystem.open(
        path,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      );
      const opened = await handle.stat();
      if (before.dev !== opened.dev || before.ino !== opened.ino) {
        throw new UserSecretInstallError("unsafe-destination");
      }
      if (!opened.isDirectory() || opened.isSymbolicLink()) {
        throw new UserSecretInstallError("unsafe-destination");
      }
      return handle;
    } catch (error) {
      await closeQuietly(handle);
      if (error instanceof UserSecretInstallError) throw error;
      throw new UserSecretInstallError("unsafe-destination", { cause: error });
    }
  }

  #requireDirectoryStatus(status: UserSecretFileStat): void {
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
}

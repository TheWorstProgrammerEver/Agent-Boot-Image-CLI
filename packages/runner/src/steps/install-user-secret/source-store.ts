import { constants } from "node:fs";

import { UserSecretInstallError } from "./errors.js";
import type {
  UserSecretFileHandle,
  UserSecretFileStat,
  UserSecretFileSystem,
} from "./filesystem.js";
import { closeQuietly, errorCode } from "./io.js";

const BOOTSTRAP_SEGMENTS = ["etc", "agent-boot", "bootstrap-secrets"] as const;
const identifier = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/u;

export interface BootstrapSecret {
  readonly contents: Uint8Array;
  readonly status: UserSecretFileStat;
}

export interface BootstrapSecretLocation {
  readonly directory: UserSecretFileHandle;
  readonly name: string;
}

export class BootstrapSecretStore {
  readonly #fileSystem: UserSecretFileSystem;
  readonly #systemRoot: string;

  constructor(fileSystem: UserSecretFileSystem, systemRoot: string) {
    this.#fileSystem = fileSystem;
    this.#systemRoot = systemRoot;
  }

  async open(secretId: string): Promise<BootstrapSecretLocation> {
    if (!identifier.test(secretId)) throw new UserSecretInstallError("unsafe-source");
    let current = await this.#openRoot();
    try {
      for (const segment of BOOTSTRAP_SEGMENTS) {
        const child = await this.#openDirectoryAt(
          current,
          segment,
        );
        try {
          await current.close();
        } catch (error) {
          await closeQuietly(child);
          throw error;
        }
        current = child;
      }
      return { directory: current, name: secretId };
    } catch (error) {
      await closeQuietly(current);
      if (error instanceof UserSecretInstallError) throw error;
      throw new UserSecretInstallError("unsafe-source", { cause: error });
    }
  }

  async read(location: BootstrapSecretLocation): Promise<BootstrapSecret> {
    const source = await this.readIfPresent(location);
    if (source === undefined) throw new UserSecretInstallError("missing-source");
    return source;
  }

  async readIfPresent(
    location: BootstrapSecretLocation,
  ): Promise<BootstrapSecret | undefined> {
    let status;
    try {
      status = await this.#fileSystem.lstatAt(location.directory, location.name);
    } catch (error) {
      if (errorCode(error) === "ENOENT") return undefined;
      throw new UserSecretInstallError("unsafe-source", { cause: error });
    }
    this.#requireSafeSource(status);
    let handle: UserSecretFileHandle | undefined;
    try {
      handle = await this.#fileSystem.openAt(
        location.directory,
        location.name,
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
      const opened = await handle.stat();
      this.#requireSafeSource(opened);
      if (opened.dev !== status.dev || opened.ino !== status.ino) {
        throw new UserSecretInstallError("unsafe-source");
      }
      return { contents: await handle.readFile(), status: opened };
    } catch (error) {
      if (error instanceof UserSecretInstallError) throw error;
      throw new UserSecretInstallError("unsafe-source", { cause: error });
    } finally {
      await closeQuietly(handle);
    }
  }

  async remove(
    location: BootstrapSecretLocation,
    expected: UserSecretFileStat,
  ): Promise<void> {
    let current;
    try {
      current = await this.#fileSystem.lstatAt(location.directory, location.name);
    } catch (error) {
      throw new UserSecretInstallError("cleanup-failed", { cause: error });
    }
    this.#requireSafeSource(current);
    if (current.dev !== expected.dev || current.ino !== expected.ino) {
      throw new UserSecretInstallError("unsafe-source");
    }
    try {
      await this.#fileSystem.unlinkAt(location.directory, location.name);
      await location.directory.sync();
    } catch (error) {
      throw new UserSecretInstallError("cleanup-failed", { cause: error });
    }
  }

  async exists(location: BootstrapSecretLocation): Promise<boolean> {
    try {
      await this.#fileSystem.lstatAt(location.directory, location.name);
      return true;
    } catch (error) {
      if (errorCode(error) === "ENOENT") return false;
      throw new UserSecretInstallError("verification-failed", { cause: error });
    }
  }

  async #openRoot(): Promise<UserSecretFileHandle> {
    let handle: UserSecretFileHandle | undefined;
    try {
      const before = await this.#fileSystem.lstat(this.#systemRoot);
      handle = await this.#fileSystem.open(
        this.#systemRoot,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      );
      const opened = await handle.stat();
      this.#requireDirectoryStatus(opened);
      if (before.dev !== opened.dev || before.ino !== opened.ino) {
        throw new UserSecretInstallError("unsafe-source");
      }
      return handle;
    } catch (error) {
      await closeQuietly(handle);
      if (error instanceof UserSecretInstallError) throw error;
      throw new UserSecretInstallError("unsafe-source", { cause: error });
    }
  }

  async #openDirectoryAt(
    parent: UserSecretFileHandle,
    name: string,
  ): Promise<UserSecretFileHandle> {
    let handle: UserSecretFileHandle | undefined;
    try {
      handle = await this.#fileSystem.openAt(
        parent,
        name,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      );
      this.#requireDirectoryStatus(await handle.stat());
      return handle;
    } catch (error) {
      await closeQuietly(handle);
      throw error;
    }
  }

  #requireDirectoryStatus(status: UserSecretFileStat): void {
    if (!status.isDirectory() || status.isSymbolicLink()) {
      throw new UserSecretInstallError("unsafe-source");
    }
  }

  #requireSafeSource(status: UserSecretFileStat): void {
    if (!status.isFile() || status.isSymbolicLink() || status.nlink !== 1) {
      throw new UserSecretInstallError("unsafe-source");
    }
  }
}

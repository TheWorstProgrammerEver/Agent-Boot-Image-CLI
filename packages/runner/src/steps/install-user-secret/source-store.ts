import { constants } from "node:fs";
import { dirname } from "node:path";

import { UserSecretInstallError } from "./errors.js";
import type {
  UserSecretFileHandle,
  UserSecretFileStat,
  UserSecretFileSystem,
} from "./filesystem.js";
import { closeQuietly, errorCode, syncDirectory } from "./io.js";
import { requireDirectoryChain, sourcePathFor } from "./paths.js";

const BOOTSTRAP_SEGMENTS = ["etc", "agent-boot", "bootstrap-secrets"] as const;

export interface BootstrapSecret {
  readonly contents: Uint8Array;
  readonly status: UserSecretFileStat;
}

export class BootstrapSecretStore {
  readonly #fileSystem: UserSecretFileSystem;
  readonly #systemRoot: string;

  constructor(fileSystem: UserSecretFileSystem, systemRoot: string) {
    this.#fileSystem = fileSystem;
    this.#systemRoot = systemRoot;
  }

  async pathFor(secretId: string): Promise<string> {
    const directory = await requireDirectoryChain(
      this.#fileSystem,
      this.#systemRoot,
      BOOTSTRAP_SEGMENTS,
    );
    return sourcePathFor(directory, secretId);
  }

  async read(path: string): Promise<BootstrapSecret> {
    const source = await this.readIfPresent(path);
    if (source === undefined) throw new UserSecretInstallError("missing-source");
    return source;
  }

  async readIfPresent(path: string): Promise<BootstrapSecret | undefined> {
    let status;
    try {
      status = await this.#fileSystem.lstat(path);
    } catch (error) {
      if (errorCode(error) === "ENOENT") return undefined;
      throw new UserSecretInstallError("unsafe-source", { cause: error });
    }
    this.#requireSafeSource(status);
    let handle: UserSecretFileHandle | undefined;
    try {
      handle = await this.#fileSystem.open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
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

  async remove(path: string, expected: UserSecretFileStat): Promise<void> {
    let current;
    try {
      current = await this.#fileSystem.lstat(path);
    } catch (error) {
      throw new UserSecretInstallError("cleanup-failed", { cause: error });
    }
    this.#requireSafeSource(current);
    if (current.dev !== expected.dev || current.ino !== expected.ino) {
      throw new UserSecretInstallError("unsafe-source");
    }
    try {
      await this.#fileSystem.unlink(path);
      await syncDirectory(this.#fileSystem, dirname(path));
    } catch (error) {
      throw new UserSecretInstallError("cleanup-failed", { cause: error });
    }
  }

  async exists(path: string): Promise<boolean> {
    try {
      await this.#fileSystem.lstat(path);
      return true;
    } catch (error) {
      if (errorCode(error) === "ENOENT") return false;
      throw new UserSecretInstallError("verification-failed", { cause: error });
    }
  }

  #requireSafeSource(status: UserSecretFileStat): void {
    if (!status.isFile() || status.isSymbolicLink() || status.nlink !== 1) {
      throw new UserSecretInstallError("unsafe-source");
    }
  }
}

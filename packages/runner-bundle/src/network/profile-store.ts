import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { open, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import { NetworkCommandError } from "./errors.js";

export interface NetworkProfileStoreOptions {
  readonly gid?: number;
  readonly path?: string;
  readonly uid?: number;
}

export class NetworkProfileStore {
  readonly #gid: number;
  readonly #path: string;
  readonly #uid: number;

  constructor(options: NetworkProfileStoreOptions = {}) {
    this.#gid = options.gid ?? 0;
    this.#path = options.path ??
      "/etc/NetworkManager/system-connections/agent-boot-wifi.nmconnection";
    this.#uid = options.uid ?? 0;
  }

  async write(contents: Uint8Array): Promise<void> {
    const directory = dirname(this.#path);
    const temporary = join(directory, `.${basename(this.#path)}.${randomUUID()}.tmp`);
    let handle;
    try {
      const directoryHandle = await open(
        directory,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      );
      try {
        handle = await open(
          temporary,
          constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW | constants.O_WRONLY,
          0o600,
        );
        await handle.writeFile(contents);
        await handle.chown(this.#uid, this.#gid);
        await handle.chmod(0o600);
        await handle.sync();
        await handle.close();
        handle = undefined;
        await rename(temporary, this.#path);
        await directoryHandle.sync();
      } finally {
        await directoryHandle.close();
      }
      const installed = await stat(this.#path);
      if (
        !installed.isFile() || installed.nlink !== 1 ||
        installed.uid !== this.#uid || installed.gid !== this.#gid ||
        (installed.mode & 0o777) !== 0o600
      ) throw new NetworkCommandError("profile-write-failed");
    } catch {
      await handle?.close().catch(() => undefined);
      await rm(temporary, { force: true }).catch(() => undefined);
      throw new NetworkCommandError("profile-write-failed");
    }
  }
}

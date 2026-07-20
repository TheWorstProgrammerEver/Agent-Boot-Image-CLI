import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { join } from "node:path";

import type { SecretResolver } from "@agent-boot/runner";

const secretId = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/u;
const MAX_SECRET_BYTES = 64 * 1_024;

export class RuntimeSecretResolver implements SecretResolver {
  readonly #directory: string;

  constructor(directory = "/run/agent-boot/secrets") {
    this.#directory = directory;
  }

  async resolve(id: string): Promise<Uint8Array> {
    if (!secretId.test(id)) throw new Error("Secret is unavailable.");
    const directoryStatus = await lstat(this.#directory);
    if (!directoryStatus.isDirectory() || directoryStatus.isSymbolicLink()) {
      throw new Error("Secret is unavailable.");
    }
    const path = join(this.#directory, id);
    const before = await lstat(path);
    if (
      !before.isFile() || before.isSymbolicLink() || before.nlink !== 1 ||
      before.size > MAX_SECRET_BYTES || (before.mode & 0o077) !== 0
    ) {
      throw new Error("Secret is unavailable.");
    }
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const opened = await handle.stat();
      if (
        !opened.isFile() || opened.nlink !== 1 ||
        opened.dev !== before.dev || opened.ino !== before.ino ||
        opened.size > MAX_SECRET_BYTES || (opened.mode & 0o077) !== 0
      ) {
        throw new Error("Secret is unavailable.");
      }
      return await handle.readFile();
    } finally {
      await handle.close();
    }
  }
}

import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

import { PromptHydrationError } from "./errors.js";

const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const identifier = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/u;

const ignoreExisting = (error: unknown): void => {
  if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
};

export interface EphemeralPromptStoreOptions {
  /** Maps the logical filesystem root for unprivileged tests. Production must use the default. */
  readonly systemRoot?: string;
}

export class EphemeralPromptStore {
  readonly #agentDirectory: string;
  readonly #runtimeDirectory: string;
  readonly #systemRoot: string;

  constructor(agentId: string, options: EphemeralPromptStoreOptions = {}) {
    const systemRoot = options.systemRoot ?? "/";
    if (!isAbsolute(systemRoot) || !identifier.test(agentId)) {
      throw new PromptHydrationError("write-failed");
    }
    this.#systemRoot = resolve(systemRoot);
    this.#runtimeDirectory = resolve(this.#systemRoot, "run", "agent-boot");
    this.#agentDirectory = join(this.#runtimeDirectory, "prompts", agentId);
  }

  async write(renderedPromptId: string, contents: Uint8Array): Promise<void> {
    const destination = this.#pathFor(renderedPromptId);
    const temporary = join(this.#agentDirectory, `.${renderedPromptId}.${randomUUID()}.tmp`);
    try {
      await this.#prepareDirectories();
      await writeFile(temporary, contents, { flag: "wx", mode: PRIVATE_FILE_MODE });
      await rename(temporary, destination);
      await chmod(destination, PRIVATE_FILE_MODE);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined);
      if (error instanceof PromptHydrationError) throw error;
      throw new PromptHydrationError("write-failed", renderedPromptId);
    }
  }

  async remove(renderedPromptId: string): Promise<void> {
    try {
      await rm(this.#pathFor(renderedPromptId), { force: true });
    } catch {
      throw new PromptHydrationError("cleanup-failed", renderedPromptId);
    }
  }

  async removeAll(): Promise<void> {
    try {
      await rm(this.#agentDirectory, { force: true, recursive: true });
    } catch {
      throw new PromptHydrationError("cleanup-failed");
    }
  }

  async #prepareDirectories(): Promise<void> {
    await mkdir(this.#systemRoot, { recursive: true });
    const systemRootStatus = await lstat(this.#systemRoot);
    if (!systemRootStatus.isDirectory() || systemRootStatus.isSymbolicLink()) {
      throw new PromptHydrationError("write-failed");
    }
    const runDirectory = join(this.#systemRoot, "run");
    await mkdir(runDirectory).catch(ignoreExisting);
    const runStatus = await lstat(runDirectory);
    if (!runStatus.isDirectory() || runStatus.isSymbolicLink()) {
      throw new PromptHydrationError("write-failed");
    }
    const promptsDirectory = join(this.#runtimeDirectory, "prompts");
    for (const directory of [this.#runtimeDirectory, promptsDirectory, this.#agentDirectory]) {
      await mkdir(directory, { mode: PRIVATE_DIRECTORY_MODE }).catch(ignoreExisting);
      const status = await lstat(directory);
      if (!status.isDirectory() || status.isSymbolicLink()) {
        throw new PromptHydrationError("write-failed");
      }
      await chmod(directory, PRIVATE_DIRECTORY_MODE);
    }
  }

  #pathFor(renderedPromptId: string): string {
    if (!identifier.test(renderedPromptId)) {
      throw new PromptHydrationError("write-failed");
    }
    return join(this.#agentDirectory, `${renderedPromptId}.md`);
  }
}

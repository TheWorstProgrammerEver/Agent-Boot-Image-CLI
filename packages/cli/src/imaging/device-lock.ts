import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import type { AuthorizedImageTarget } from "../drives/index.js";
import { ArtifactAcquisitionError } from "../images/errors.js";
import { acquireFileLock } from "../images/file-lock.js";
import { ImageWriteError } from "./errors.js";
import type { DeviceOperationLock, DeviceOperationLocker } from "./model.js";

export interface FileDeviceOperationLockerOptions {
  readonly lockDirectory: string;
  readonly pollMs?: number;
  readonly timeoutMs?: number;
}

const lockName = (target: AuthorizedImageTarget): string => `${createHash("sha256")
  .update(target.resolvedTarget)
  .digest("hex")}.lock`;

export class FileDeviceOperationLocker implements DeviceOperationLocker {
  readonly #lockDirectory: string;
  readonly #pollMs: number;
  readonly #timeoutMs: number;

  constructor(options: FileDeviceOperationLockerOptions) {
    this.#lockDirectory = options.lockDirectory;
    this.#pollMs = options.pollMs ?? 25;
    this.#timeoutMs = options.timeoutMs ?? 5_000;
  }

  async acquire(
    target: AuthorizedImageTarget,
    cancellation: AbortSignal,
  ): Promise<DeviceOperationLock> {
    cancellation.throwIfAborted();
    try {
      await mkdir(this.#lockDirectory, { recursive: true, mode: 0o700 });
      const release = await acquireFileLock(
        join(this.#lockDirectory, lockName(target)),
        this.#timeoutMs,
        this.#pollMs,
        cancellation,
      );
      return { release };
    } catch (error) {
      if (cancellation.aborted) {
        throw new ImageWriteError("canceled", "Device lock acquisition was canceled.", {
          cause: error,
        });
      }
      if (error instanceof ArtifactAcquisitionError && error.code === "lock-timeout") {
        throw new ImageWriteError("lock-contention", "Target device is locked by another operation.");
      }
      throw new ImageWriteError("lock-failed", "Target device lock could not be acquired.", {
        cause: error,
      });
    }
  }
}

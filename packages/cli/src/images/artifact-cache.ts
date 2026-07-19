import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { OsLock } from "@agent-boot/protocol";

import { cachePathsFor, type ArtifactCachePaths } from "./cache-layout.js";
import { sha256File } from "./checksum.js";
import { downloadArtifact } from "./download.js";
import { ArtifactAcquisitionError } from "./errors.js";
import { acquireFileLock } from "./file-lock.js";
import type {
  AcquiredOsArtifact,
  ArtifactMetadataInspector,
  ArtifactTransport,
} from "./model.js";

export interface ArtifactCacheOptions {
  readonly cacheDirectory: string;
  readonly inspector: ArtifactMetadataInspector;
  readonly lockPollMs?: number;
  readonly lockTimeoutMs?: number;
  readonly transport: ArtifactTransport;
}

const errorCode = (error: unknown): string | undefined =>
  (error as NodeJS.ErrnoException).code;

const existingRegularSize = async (path: string): Promise<number | undefined> => {
  try {
    const status = await lstat(path);
    return status.isFile() ? status.size : -1;
  } catch (error) {
    if (errorCode(error) === "ENOENT") return undefined;
    throw new ArtifactAcquisitionError("cache-access");
  }
};

const syncDirectory = async (path: string): Promise<void> => {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
};

export class ArtifactCache {
  readonly #cacheDirectory: string;
  readonly #inspector: ArtifactMetadataInspector;
  readonly #lockPollMs: number;
  readonly #lockTimeoutMs: number;
  readonly #transport: ArtifactTransport;

  constructor(options: ArtifactCacheOptions) {
    if (options.cacheDirectory.trim() === "") throw new TypeError("cacheDirectory must not be empty");
    this.#cacheDirectory = options.cacheDirectory;
    this.#inspector = options.inspector;
    this.#lockPollMs = options.lockPollMs ?? 50;
    this.#lockTimeoutMs = options.lockTimeoutMs ?? 12 * 60 * 60 * 1_000;
    if (!Number.isSafeInteger(this.#lockPollMs) || this.#lockPollMs < 1) {
      throw new RangeError("lockPollMs must be a positive integer");
    }
    if (!Number.isSafeInteger(this.#lockTimeoutMs) || this.#lockTimeoutMs < 1) {
      throw new RangeError("lockTimeoutMs must be a positive integer");
    }
    this.#transport = options.transport;
  }

  async acquire(lock: OsLock): Promise<AcquiredOsArtifact> {
    const paths = cachePathsFor(this.#cacheDirectory, lock.artifact.sha256);
    try {
      await Promise.all([
        mkdir(paths.artifactDirectory, { recursive: true, mode: 0o700 }),
        mkdir(paths.lockDirectory, { recursive: true, mode: 0o700 }),
        mkdir(paths.partialDirectory, { recursive: true, mode: 0o700 }),
        mkdir(paths.quarantineDirectory, { recursive: true, mode: 0o700 }),
      ]);
    } catch {
      throw new ArtifactAcquisitionError("cache-access");
    }

    const release = await acquireFileLock(paths.lock, this.#lockTimeoutMs, this.#lockPollMs);
    try {
      try {
        if (await this.#isVerified(paths.artifact, lock)) {
          return await this.#result(paths.artifact, lock, "cache");
        }
        if (await existingRegularSize(paths.artifact) !== undefined) {
          await this.#quarantine(paths.artifact, paths);
        }
        const promotedPartial = await this.#promoteCompletedPartial(paths, lock);
        if (!promotedPartial) {
          await this.#download(paths, lock);
          await this.#verifyAndPromote(paths, lock);
        }
        return await this.#result(paths.artifact, lock, "download");
      } catch (error) {
        if (error instanceof ArtifactAcquisitionError) throw error;
        throw new ArtifactAcquisitionError("cache-access");
      }
    } finally {
      await release();
    }
  }

  async #result(
    path: string,
    lock: OsLock,
    source: AcquiredOsArtifact["source"],
  ): Promise<AcquiredOsArtifact> {
    const metadata = await this.#inspector.inspect(path, lock.artifact.byteLength);
    return { ...metadata, path, sha256: lock.artifact.sha256, source };
  }

  async #isVerified(path: string, lock: OsLock): Promise<boolean> {
    const size = await existingRegularSize(path);
    if (size === undefined || size === -1 || size !== lock.artifact.byteLength) return false;
    try {
      return await sha256File(path) === lock.artifact.sha256;
    } catch {
      throw new ArtifactAcquisitionError("cache-access");
    }
  }

  async #quarantine(path: string, paths: ArtifactCachePaths): Promise<void> {
    const target = join(paths.quarantineDirectory, `sha256-${randomUUID()}.img.xz`);
    try {
      await rename(path, target);
      await syncDirectory(paths.quarantineDirectory);
    } catch (error) {
      if (errorCode(error) !== "ENOENT") throw new ArtifactAcquisitionError("cache-access");
    }
  }

  async #promoteCompletedPartial(paths: ArtifactCachePaths, lock: OsLock): Promise<boolean> {
    const size = await existingRegularSize(paths.partial);
    if (size === undefined) return false;
    if (size !== lock.artifact.byteLength) {
      if (size === -1 || size > lock.artifact.byteLength) {
        await this.#quarantine(paths.partial, paths);
      }
      return false;
    }
    let verified = false;
    try {
      verified = await sha256File(paths.partial) === lock.artifact.sha256;
    } catch {
      throw new ArtifactAcquisitionError("cache-access");
    }
    if (!verified) {
      await rm(paths.partial, { force: true });
      return false;
    }
    await this.#promote(paths);
    return true;
  }

  async #download(paths: ArtifactCachePaths, lock: OsLock): Promise<void> {
    const partialSize = await existingRegularSize(paths.partial);
    if (partialSize === -1) {
      await this.#quarantine(paths.partial, paths);
    }
    const offset = partialSize === undefined || partialSize === -1 ? 0 : partialSize;
    await downloadArtifact({
      expectedByteLength: lock.artifact.byteLength,
      offset,
      path: paths.partial,
      transport: this.#transport,
      url: lock.artifact.url,
    });
  }

  async #verifyAndPromote(paths: ArtifactCachePaths, lock: OsLock): Promise<void> {
    let digest: string;
    try {
      digest = await sha256File(paths.partial);
    } catch {
      throw new ArtifactAcquisitionError("cache-access");
    }
    if (digest !== lock.artifact.sha256) {
      await rm(paths.partial, { force: true });
      throw new ArtifactAcquisitionError("checksum-mismatch");
    }
    await this.#promote(paths);
  }

  async #promote(paths: ArtifactCachePaths): Promise<void> {
    try {
      await rename(paths.partial, paths.artifact);
      await syncDirectory(dirname(paths.artifact));
    } catch {
      throw new ArtifactAcquisitionError("cache-access");
    }
  }
}

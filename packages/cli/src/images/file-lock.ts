import { randomUUID } from "node:crypto";
import { link, open, readFile, rm } from "node:fs/promises";

import { ArtifactAcquisitionError } from "./errors.js";
import { createLockOwnerIdentity, lockOwnerIsAlive } from "./lock-owner.js";

type ReleaseLock = () => Promise<void>;

const delay = (milliseconds: number): Promise<void> =>
  new Promise(resolve => setTimeout(resolve, milliseconds));

const errorCode = (error: unknown): string | undefined =>
  (error as NodeJS.ErrnoException).code;

const prepareLockCandidate = async (path: string, identity: string): Promise<string> => {
  const candidate = `${path}.${randomUUID()}.pending`;
  try {
    const handle = await open(candidate, "wx", 0o600);
    try {
      await handle.writeFile(identity, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    return candidate;
  } catch {
    try {
      await rm(candidate, { force: true });
    } catch {
      // The candidate never controls lock ownership, so stale residue cannot block acquisition.
    }
    throw new ArtifactAcquisitionError("cache-access");
  }
};

const tryAcquireOwnedLock = async (path: string): Promise<ReleaseLock | undefined> => {
  let identity;
  try {
    identity = await createLockOwnerIdentity();
  } catch {
    throw new ArtifactAcquisitionError("cache-access");
  }

  const candidate = await prepareLockCandidate(path, identity);
  try {
    await link(candidate, path);
  } catch (error) {
    if (errorCode(error) === "EEXIST") return undefined;
    throw new ArtifactAcquisitionError("cache-access");
  } finally {
    try {
      await rm(candidate, { force: true });
    } catch {
      // A fully initialized lock is already visible or another owner won the race.
    }
  }

  return async () => {
    try {
      if (await readFile(path, "utf8") === identity) await rm(path);
    } catch (error) {
      if (errorCode(error) !== "ENOENT") throw new ArtifactAcquisitionError("cache-access");
    }
  };
};

const readIdentity = async (path: string): Promise<string | undefined> => {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (errorCode(error) === "ENOENT") return undefined;
    throw new ArtifactAcquisitionError("cache-access");
  }
};

async function recoverStaleLock(
  path: string,
  observedIdentity: string,
  deadline: number,
  pollMs: number,
): Promise<boolean> {
  const releaseRecovery = await acquireFileLockUntil(`${path}.recovery`, deadline, pollMs);

  try {
    const currentIdentity = await readIdentity(path);
    if (currentIdentity !== observedIdentity || await lockOwnerIsAlive(currentIdentity)) {
      return false;
    }
    await rm(path);
    return true;
  } catch (error) {
    if (errorCode(error) === "ENOENT") return false;
    if (error instanceof ArtifactAcquisitionError) throw error;
    throw new ArtifactAcquisitionError("cache-access");
  } finally {
    await releaseRecovery();
  }
}

async function acquireFileLockUntil(
  path: string,
  deadline: number,
  pollMs: number,
): Promise<ReleaseLock> {
  while (Date.now() <= deadline) {
    const release = await tryAcquireOwnedLock(path);
    if (release !== undefined) return release;

    const observedIdentity = await readIdentity(path);
    if (observedIdentity === undefined) continue;
    if (
      !await lockOwnerIsAlive(observedIdentity)
      && await recoverStaleLock(path, observedIdentity, deadline, pollMs)
    ) continue;
    await delay(pollMs);
  }
  throw new ArtifactAcquisitionError("lock-timeout");
}

export const acquireFileLock = async (
  path: string,
  timeoutMs: number,
  pollMs: number,
): Promise<ReleaseLock> => {
  return acquireFileLockUntil(path, Date.now() + timeoutMs, pollMs);
};

import { randomUUID } from "node:crypto";
import { open, readFile, rm } from "node:fs/promises";

import { ArtifactAcquisitionError } from "./errors.js";

const delay = (milliseconds: number): Promise<void> =>
  new Promise(resolve => setTimeout(resolve, milliseconds));

const errorCode = (error: unknown): string | undefined =>
  (error as NodeJS.ErrnoException).code;

const ownerIsAlive = async (path: string): Promise<boolean> => {
  try {
    const owner = Number.parseInt((await readFile(path, "utf8")).split(":", 1)[0] ?? "", 10);
    if (!Number.isSafeInteger(owner) || owner < 1) return true;
    process.kill(owner, 0);
    return true;
  } catch (error) {
    return errorCode(error) !== "ESRCH";
  }
};

export const acquireFileLock = async (
  path: string,
  timeoutMs: number,
  pollMs: number,
): Promise<() => Promise<void>> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    try {
      const handle = await open(path, "wx", 0o600);
      const identity = `${String(process.pid)}:${randomUUID()}\n`;
      try {
        await handle.writeFile(identity, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      return async () => {
        try {
          if (await readFile(path, "utf8") === identity) await rm(path, { force: true });
        } catch (error) {
          if (errorCode(error) !== "ENOENT") throw new ArtifactAcquisitionError("cache-access");
        }
      };
    } catch (error) {
      if (errorCode(error) !== "EEXIST") {
        throw new ArtifactAcquisitionError("cache-access");
      }
      if (!(await ownerIsAlive(path))) {
        await rm(path, { force: true });
        continue;
      }
      await delay(pollMs);
    }
  }
  throw new ArtifactAcquisitionError("lock-timeout");
};

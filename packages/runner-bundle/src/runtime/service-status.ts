import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { open, rename, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

export type RunnerServiceStatus = "failed" | "starting" | "succeeded";

const documentFor = (status: RunnerServiceStatus): string => `${JSON.stringify({
  ...(status === "failed" ? { recovery: "inspect-tty2-or-journal" } : {}),
  schemaVersion: 1,
  status,
})}\n`;

export const writeRunnerServiceStatus = async (
  path: string,
  status: RunnerServiceStatus,
): Promise<void> => {
  const directory = dirname(path);
  const temporary = join(directory, `.${basename(path)}.${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await open(
      temporary,
      constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW | constants.O_WRONLY,
      0o600,
    );
    await handle.writeFile(documentFor(status));
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, path);
    const directoryHandle = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY);
    try {
      await directoryHandle.sync();
    } finally {
      await directoryHandle.close();
    }
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
};

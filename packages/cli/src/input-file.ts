import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { resolve } from "node:path";

export const readRegularInputFile = async (pathInput: string): Promise<Buffer> => {
  const path = resolve(pathInput);
  const metadata = await lstat(path);
  if (metadata.isSymbolicLink() || !metadata.isFile() || await realpath(path) !== path) {
    throw new Error("Input must be a regular file with no symbolic links.");
  }
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const openedMetadata = await handle.stat();
    if (!openedMetadata.isFile()) throw new Error("Input must be a regular file.");
    return await handle.readFile();
  } finally {
    await handle.close();
  }
};

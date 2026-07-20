import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import type { AgentDefinition } from "@agent-boot/definition";

const maximumSecretBytes = 1_048_576;

const isWithin = (root: string, path: string): boolean => {
  const suffix = relative(root, path);
  return suffix !== "" && suffix !== ".." && !suffix.startsWith(`..${sep}`);
};

const readSecret = async (path: string): Promise<Buffer> => {
  const metadata = await lstat(path);
  if (
    metadata.isSymbolicLink() || !metadata.isFile() || metadata.nlink !== 1 ||
    metadata.size > maximumSecretBytes || await realpath(path) !== resolve(path)
  ) throw new Error("unsafe secret source");
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.nlink !== 1 || opened.size > maximumSecretBytes) {
      throw new Error("unsafe secret source");
    }
    return await handle.readFile();
  } finally {
    await handle.close();
  }
};

export const loadBootstrapSecrets = async (
  definition: AgentDefinition,
): Promise<Map<string, Uint8Array>> => {
  const root = dirname(fileURLToPath(definition.definitionUrl));
  const output = new Map<string, Uint8Array>();
  try {
    for (const secret of definition.secrets) {
      const source = resolve(fileURLToPath(secret.source.url));
      if (!isWithin(root, source)) throw new Error("unsafe secret source");
      output.set(secret.id, await readSecret(source));
    }
    return output;
  } catch (error) {
    for (const value of output.values()) value.fill(0);
    throw error;
  }
};

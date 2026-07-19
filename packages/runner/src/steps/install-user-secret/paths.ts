import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import type { UserSecretFileSystem } from "./filesystem.js";
import { UserSecretInstallError } from "./errors.js";

const identifier = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/u;

export const containedDestination = (home: string, destination: string): string => {
  const segments = destination.split("/");
  if (
    !isAbsolute(home) ||
    isAbsolute(destination) ||
    destination.includes("\\") ||
    segments.some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw new UserSecretInstallError("unsafe-destination");
  }
  const candidate = resolve(home, ...segments);
  const containment = relative(home, candidate);
  if (
    containment === "" ||
    containment === ".." ||
    containment.startsWith(`..${sep}`) ||
    isAbsolute(containment)
  ) {
    throw new UserSecretInstallError("unsafe-destination");
  }
  return candidate;
};

export const sourcePathFor = (bootstrapDirectory: string, secretId: string): string => {
  if (!identifier.test(secretId)) throw new UserSecretInstallError("unsafe-source");
  const source = resolve(bootstrapDirectory, secretId);
  if (dirname(source) !== bootstrapDirectory) {
    throw new UserSecretInstallError("unsafe-source");
  }
  return source;
};

export const requireDirectoryChain = async (
  fileSystem: UserSecretFileSystem,
  root: string,
  segments: readonly string[],
): Promise<string> => {
  let current = root;
  for (const segment of ["", ...segments]) {
    if (segment !== "") current = join(current, segment);
    let status;
    try {
      status = await fileSystem.lstat(current);
    } catch (error) {
      throw new UserSecretInstallError("unsafe-source", { cause: error });
    }
    if (!status.isDirectory() || status.isSymbolicLink()) {
      throw new UserSecretInstallError("unsafe-source");
    }
  }
  return current;
};

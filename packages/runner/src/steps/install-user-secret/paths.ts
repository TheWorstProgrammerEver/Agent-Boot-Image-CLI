import { isAbsolute, relative, resolve, sep } from "node:path";

import { UserSecretInstallError } from "./errors.js";

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

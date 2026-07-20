import { chmod, lstat, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { customizationError } from "./errors.js";
import type { PrivateMountRoot, PrivateMountRootFactory } from "./model.js";

export class SystemPrivateMountRootFactory implements PrivateMountRootFactory {
  async create(): Promise<PrivateMountRoot> {
    let path: string | undefined;
    try {
      path = await mkdtemp(join(tmpdir(), "agent-boot-customize-"));
      await chmod(path, 0o700);
      const status = await lstat(path);
      if (!status.isDirectory() || status.isSymbolicLink() || (status.mode & 0o777) !== 0o700) {
        throw new Error("unsafe");
      }
    } catch {
      if (path !== undefined) {
        try {
          await rm(path, { force: true, recursive: true });
        } catch {
          // The public error remains bounded and contains no host path details.
        }
      }
      throw customizationError("temporary-root-failed");
    }
    const mountRootPath = path;
    return {
      path: mountRootPath,
      remove: async () => {
        await rm(mountRootPath, { force: true, recursive: true });
      },
    };
  }
}

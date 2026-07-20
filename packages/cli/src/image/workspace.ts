import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ImageWorkspace } from "./model.js";

export const createSystemImageWorkspace = async (): Promise<ImageWorkspace> => {
  const path = await mkdtemp(join(tmpdir(), "agent-boot-image-"));
  const assemblyDirectory = join(path, "assembly");
  await chmod(path, 0o700);
  return {
    assemblyDirectory,
    path,
    remove: async () => { await rm(path, { force: true, recursive: true }); },
  };
};

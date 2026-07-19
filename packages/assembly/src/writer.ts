import { constants } from "node:fs";
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  realpath,
  rename,
  rm,
} from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";

import { ASSEMBLY_PATHS } from "@agent-boot/protocol";

export interface AssemblyFile {
  readonly path: string;
  readonly contents: Uint8Array;
  readonly mode: 0o600 | 0o644 | 0o700 | 0o755;
}

export interface AssemblyWriteHooks {
  readonly beforeCommit?: () => void | Promise<void>;
  readonly afterExistingMoved?: () => void | Promise<void>;
}

export interface WriteAssemblyOptions {
  readonly replace?: boolean;
  readonly hooks?: AssemblyWriteHooks;
}

export class AssemblyRecoveryError extends Error {
  readonly recoveryPath: string;

  constructor(recoveryPath: string) {
    super(
      "Assembly replacement and rollback both failed; " +
      "the previous assembly remains available at the recovery path.",
    );
    this.name = "AssemblyRecoveryError";
    this.recoveryPath = recoveryPath;
  }
}

const isMissing = (error: unknown): boolean =>
  error instanceof Error && "code" in error && error.code === "ENOENT";

const inspectExistingOutput = async (outputPath: string): Promise<"absent" | "directory"> => {
  try {
    const metadata = await lstat(outputPath);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      throw new Error("Existing output must be a regular directory, not a link or special file.");
    }
    return "directory";
  } catch (error) {
    if (isMissing(error)) return "absent";
    throw error;
  }
};

const assertSafeParent = async (parentPath: string): Promise<void> => {
  const canonicalParent = await realpath(parentPath);
  if (canonicalParent !== resolve(parentPath)) {
    throw new Error("The output parent must not contain symbolic links.");
  }
  const metadata = await lstat(canonicalParent);
  if (!metadata.isDirectory()) throw new Error("The output parent must be a directory.");
};

const assertReplaceableAssembly = async (outputPath: string): Promise<void> => {
  for (const document of [
    ASSEMBLY_PATHS.manifest,
    ASSEMBLY_PATHS.runnerPlan,
    ASSEMBLY_PATHS.osLock,
  ]) {
    const metadata = await lstat(join(outputPath, document));
    if (metadata.isSymbolicLink() || !metadata.isFile()) {
      throw new Error("Existing output is not a recognizable assembly directory.");
    }
  }
};

const assertAssemblyPath = (path: string): void => {
  const resolved = resolve("/assembly", path);
  const suffix = relative("/assembly", resolved);
  if (
    suffix === "" ||
    suffix.startsWith(`..${sep}`) ||
    suffix === ".." ||
    suffix !== path ||
    path.includes("\\") ||
    path.startsWith("/")
  ) {
    throw new Error("Assembly file paths must be normalized relative paths.");
  }
};

const syncDirectory = async (path: string): Promise<void> => {
  const handle = await open(path, constants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
};

const writeStagingDirectory = async (
  stagingPath: string,
  files: readonly AssemblyFile[],
): Promise<void> => {
  const seen = new Set<string>();
  const directories = new Set<string>([stagingPath]);
  for (const file of files) {
    assertAssemblyPath(file.path);
    if (seen.has(file.path)) throw new Error("Assembly file paths must be unique.");
    seen.add(file.path);

    const targetPath = join(stagingPath, file.path);
    const targetDirectory = dirname(targetPath);
    await mkdir(targetDirectory, { recursive: true, mode: 0o700 });
    for (
      let directory = targetDirectory;
      directory.startsWith(`${stagingPath}${sep}`);
      directory = dirname(directory)
    ) directories.add(directory);
    const handle = await open(
      targetPath,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
      file.mode,
    );
    try {
      await handle.writeFile(file.contents);
      await handle.sync();
    } finally {
      await handle.close();
    }
  }
  for (const directory of [...directories].sort((left, right) => right.length - left.length)) {
    await syncDirectory(directory);
  }
};

export const writeAssemblyAtomically = async (
  outputPathInput: string,
  files: readonly AssemblyFile[],
  options: WriteAssemblyOptions = {},
): Promise<void> => {
  const outputPath = resolve(outputPathInput);
  const parentPath = dirname(outputPath);
  if (outputPath === parentPath) throw new Error("The filesystem root cannot be an assembly output.");
  await assertSafeParent(parentPath);
  const outputState = await inspectExistingOutput(outputPath);
  if (outputState === "directory" && options.replace !== true) {
    throw new Error("Output already exists; pass the explicit replace option to replace it.");
  }
  if (outputState === "directory") await assertReplaceableAssembly(outputPath);

  const stagingPath = await mkdtemp(join(parentPath, `.${basename(outputPath)}.staging-`));
  let backupPath: string | undefined;
  try {
    await writeStagingDirectory(stagingPath, files);
    await options.hooks?.beforeCommit?.();

    if (outputState === "directory") {
      const replacementBackupPath = await mkdtemp(
        join(parentPath, `.${basename(outputPath)}.backup-`),
      );
      backupPath = replacementBackupPath;
      await rm(replacementBackupPath, { recursive: true, force: true });
      await rename(outputPath, replacementBackupPath);
      try {
        await options.hooks?.afterExistingMoved?.();
        await rename(stagingPath, outputPath);
      } catch (replacementError) {
        try {
          await rename(replacementBackupPath, outputPath);
          backupPath = undefined;
        } catch {
          backupPath = undefined;
          throw new AssemblyRecoveryError(replacementBackupPath);
        }
        throw replacementError;
      }
    } else {
      await rename(stagingPath, outputPath);
    }
    await syncDirectory(parentPath);
    if (backupPath !== undefined) {
      await rm(backupPath, { recursive: true, force: true });
      backupPath = undefined;
      await syncDirectory(parentPath);
    }
  } finally {
    await rm(stagingPath, { recursive: true, force: true });
    if (backupPath !== undefined) await rm(backupPath, { recursive: true, force: true });
  }
};

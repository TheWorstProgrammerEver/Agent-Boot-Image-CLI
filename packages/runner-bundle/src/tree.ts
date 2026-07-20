import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, readdir, readlink, symlink } from "node:fs/promises";
import { dirname, isAbsolute, join, posix, relative, resolve, sep } from "node:path";

import { canonicalJson } from "./canonical-json.js";
import { sha256 } from "./digest.js";
import type { BundleEntry } from "./model.js";

const modeString = (mode: number): string => (mode & 0o777).toString(8).padStart(4, "0");

const normalizedRelativePath = (root: string, path: string): string =>
  relative(root, path).split(sep).join(posix.sep);

const assertSafeLink = (root: string, path: string, target: string): void => {
  if (isAbsolute(target) || target.includes("\0")) {
    throw new Error("Runtime symlinks must be relative and remain inside the runtime tree.");
  }
  const resolved = resolve(dirname(path), target);
  const containment = relative(root, resolved);
  if (containment === ".." || containment.startsWith(`..${sep}`) || isAbsolute(containment)) {
    throw new Error("Runtime symlinks must be relative and remain inside the runtime tree.");
  }
};

export interface TreeRecord {
  readonly kind: "directory" | "file" | "symlink";
  readonly linkTarget?: string;
  readonly mode?: string;
  readonly path: string;
  readonly sha256?: string;
  readonly size?: number;
}

export const inspectTree = async (rootInput: string): Promise<readonly TreeRecord[]> => {
  const root = resolve(rootInput);
  const rootStatus = await lstat(root);
  if (!rootStatus.isDirectory() || rootStatus.isSymbolicLink()) {
    throw new Error("Tree root must be a regular directory.");
  }
  const records: TreeRecord[] = [];

  const visit = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
    for (const entry of entries) {
      const path = join(directory, entry.name);
      const relativePath = normalizedRelativePath(root, path);
      const status = await lstat(path);
      if (status.isSymbolicLink()) {
        const linkTarget = await readlink(path);
        assertSafeLink(root, path, linkTarget);
        records.push({ kind: "symlink", linkTarget, path: relativePath });
      } else if (status.isDirectory()) {
        records.push({ kind: "directory", mode: modeString(status.mode), path: relativePath });
        await visit(path);
      } else if (status.isFile()) {
        const handle = await open(path, "r");
        try {
          const contents = await handle.readFile();
          records.push({
            kind: "file",
            mode: modeString(status.mode),
            path: relativePath,
            sha256: sha256(contents),
            size: contents.byteLength,
          });
        } finally {
          await handle.close();
        }
      } else {
        throw new Error("Bundle sources may contain only directories, regular files, and safe symlinks.");
      }
    }
  };

  await visit(root);
  return records;
};

export const treeSha256 = (records: readonly TreeRecord[]): string =>
  sha256(canonicalJson(records));

export const copyTree = async (
  sourceRoot: string,
  destinationRoot: string,
  records: readonly TreeRecord[],
): Promise<void> => {
  await mkdir(destinationRoot, { mode: 0o755, recursive: true });
  for (const record of records) {
    const source = join(sourceRoot, ...record.path.split("/"));
    const destination = join(destinationRoot, ...record.path.split("/"));
    if (record.kind === "directory") {
      await mkdir(destination, { mode: Number.parseInt(record.mode ?? "0755", 8) });
      await chmod(destination, Number.parseInt(record.mode ?? "0755", 8));
      continue;
    }
    await mkdir(dirname(destination), { mode: 0o755, recursive: true });
    if (record.kind === "symlink") {
      await symlink(record.linkTarget ?? "", destination);
      continue;
    }
    const sourceHandle = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW);
    const destinationHandle = await open(
      destination,
      "wx",
      Number.parseInt(record.mode ?? "0644", 8),
    );
    try {
      const sourceStatus = await sourceHandle.stat();
      const contents = await sourceHandle.readFile();
      if (
        !sourceStatus.isFile() ||
        contents.byteLength !== record.size ||
        sha256(contents) !== record.sha256
      ) {
        throw new Error("Bundle source changed after verification.");
      }
      await destinationHandle.writeFile(contents);
      await destinationHandle.sync();
      await destinationHandle.chmod(Number.parseInt(record.mode ?? "0644", 8));
    } finally {
      await Promise.allSettled([sourceHandle.close(), destinationHandle.close()]);
    }
  }
};

export const bundleEntries = async (root: string): Promise<readonly BundleEntry[]> => {
  const records = await inspectTree(root);
  return records.map((record): BundleEntry => {
    const path = `root/${record.path}`;
    const targetPath = `/${record.path}`;
    if (record.kind === "directory") {
      return { kind: record.kind, mode: record.mode ?? "0755", path, targetPath };
    }
    if (record.kind === "symlink") {
      return { kind: record.kind, linkTarget: record.linkTarget ?? "", path, targetPath };
    }
    return {
      kind: record.kind,
      mode: record.mode ?? "0644",
      path,
      sha256: record.sha256 ?? "",
      size: record.size ?? 0,
      targetPath,
    };
  });
};

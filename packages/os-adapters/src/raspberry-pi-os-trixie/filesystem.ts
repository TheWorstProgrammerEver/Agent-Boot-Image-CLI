import { constants } from "node:fs";
import { randomUUID } from "node:crypto";
import {
  chmod,
  chown,
  lchown,
  lstat,
  mkdir,
  open,
  readFile,
  readlink,
  realpath,
  rename,
  rm,
  stat,
  symlink,
} from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";

import { adapterError } from "./errors.js";
import type { ImageIdentity, ImageOwnership } from "./model.js";

export type ImagePlanEntry =
  | {
      readonly identity: ImageIdentity;
      readonly kind: "directory";
      readonly mode: number;
      readonly path: string;
    }
  | {
      readonly contents: Uint8Array;
      readonly identity: ImageIdentity;
      readonly kind: "file";
      readonly mode: number;
      readonly path: string;
    }
  | {
      readonly identity: ImageIdentity;
      readonly kind: "symlink";
      readonly linkTarget: string;
      readonly path: string;
    };

const isMissing = (error: unknown): boolean =>
  error instanceof Error && "code" in error && error.code === "ENOENT";

const safeRelativePath = (path: string): string => {
  if (
    path === "" || path.startsWith("/") || path.endsWith("/") || path.includes("\\") ||
    path.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
  ) throw adapterError("unsafe-path", "A target path is unsafe.");
  return path;
};

const targetPath = (root: string, path: string): string => {
  const target = resolve(root, safeRelativePath(path));
  const suffix = relative(root, target);
  if (suffix === "" || suffix === ".." || suffix.startsWith(`..${sep}`)) {
    throw adapterError("unsafe-path", "A target path escapes its image root.");
  }
  return target;
};

const modeOf = (mode: number): number => mode & 0o777;

const syncDirectory = async (path: string): Promise<void> => {
  const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
};

export class PosixImageOwnership implements ImageOwnership {
  async inspect(path: string, symbolicLink = false): Promise<ImageIdentity> {
    const status = symbolicLink ? await lstat(path) : await stat(path);
    return { gid: status.gid, uid: status.uid };
  }

  async set(path: string, identity: ImageIdentity, symbolicLink = false): Promise<void> {
    if (symbolicLink) await lchown(path, identity.uid, identity.gid);
    else await chown(path, identity.uid, identity.gid);
  }
}

const sameIdentity = (left: ImageIdentity, right: ImageIdentity): boolean =>
  left.uid === right.uid && left.gid === right.gid;

export class SafeImageWriter {
  readonly #ownership: ImageOwnership;
  readonly #root: string;

  private constructor(root: string, ownership: ImageOwnership) {
    this.#root = root;
    this.#ownership = ownership;
  }

  static async create(rootInput: string, ownership: ImageOwnership): Promise<SafeImageWriter> {
    const root = resolve(rootInput);
    const status = await lstat(root);
    if (!status.isDirectory() || status.isSymbolicLink() || resolve(await realpath(root)) !== root) {
      throw adapterError("unsafe-path", "An image root is unsafe.");
    }
    return new SafeImageWriter(root, ownership);
  }

  async readOptional(path: string): Promise<Uint8Array | undefined> {
    const target = targetPath(this.#root, path);
    await this.#assertParents(target);
    try {
      const status = await lstat(target);
      if (!status.isFile() || status.isSymbolicLink() || status.nlink !== 1) {
        throw adapterError("unsafe-path", "An existing target file is unsafe.");
      }
      return await readFile(target);
    } catch (error) {
      if (isMissing(error)) return undefined;
      throw error;
    }
  }

  async preflight(entries: readonly ImagePlanEntry[]): Promise<void> {
    const paths = new Set<string>();
    for (const entry of entries) {
      if (paths.has(entry.path)) throw adapterError("invalid-input", "Target paths must be unique.");
      paths.add(entry.path);
      const target = targetPath(this.#root, entry.path);
      await this.#assertParents(target, true);
      try {
        const status = await lstat(target);
        if (entry.kind === "directory" && (!status.isDirectory() || status.isSymbolicLink())) {
          throw adapterError("unsafe-path", "An existing target directory is unsafe.");
        }
        if (entry.kind === "file" && (!status.isFile() || status.isSymbolicLink() || status.nlink !== 1)) {
          throw adapterError("unsafe-path", "An existing target file is unsafe.");
        }
        if (entry.kind === "symlink") {
          if (!status.isSymbolicLink() || await readlink(target) !== entry.linkTarget) {
            throw adapterError("unsafe-path", "An existing target link is incompatible.");
          }
        }
      } catch (error) {
        if (!isMissing(error)) throw error;
      }
    }
  }

  async apply(entries: readonly ImagePlanEntry[]): Promise<void> {
    const ordered = [...entries].sort((left, right) => {
      const kindOrder = { directory: 0, file: 1, symlink: 2 } as const;
      const byKind = kindOrder[left.kind] - kindOrder[right.kind];
      if (byKind !== 0) return byKind;
      const depth = left.path.split("/").length - right.path.split("/").length;
      return depth === 0 ? left.path.localeCompare(right.path) : depth;
    });
    for (const entry of ordered) {
      if (entry.kind === "directory") await this.#directory(entry);
      else if (entry.kind === "file") await this.#file(entry);
      else await this.#link(entry);
    }
  }

  async verify(entries: readonly ImagePlanEntry[]): Promise<void> {
    for (const entry of entries) {
      const target = targetPath(this.#root, entry.path);
      const status = await lstat(target);
      if (entry.kind === "directory") {
        if (!status.isDirectory() || status.isSymbolicLink() || modeOf(status.mode) !== entry.mode) {
          throw adapterError("postcondition-failed", "A target directory failed verification.");
        }
      } else if (entry.kind === "file") {
        if (
          !status.isFile() || status.isSymbolicLink() || status.nlink !== 1 ||
          modeOf(status.mode) !== entry.mode ||
          !Buffer.from(await readFile(target)).equals(Buffer.from(entry.contents))
        ) throw adapterError("postcondition-failed", "A target file failed verification.");
      } else if (!status.isSymbolicLink() || await readlink(target) !== entry.linkTarget) {
        throw adapterError("postcondition-failed", "A target link failed verification.");
      }
      const actual = await this.#ownership.inspect(target, entry.kind === "symlink");
      if (!sameIdentity(actual, entry.identity)) {
        throw adapterError("postcondition-failed", "Target ownership failed verification.");
      }
    }
  }

  async #assertParents(target: string, allowMissing = false): Promise<void> {
    const chain: string[] = [];
    for (let current = dirname(target); current !== this.#root; current = dirname(current)) {
      chain.push(current);
    }
    for (const path of chain.reverse()) {
      try {
        const status = await lstat(path);
        if (!status.isDirectory() || status.isSymbolicLink()) {
          throw adapterError("unsafe-path", "A target path contains an unsafe directory.");
        }
      } catch (error) {
        if (allowMissing && isMissing(error)) return;
        throw error;
      }
    }
  }

  async #directory(entry: Extract<ImagePlanEntry, { kind: "directory" }>): Promise<void> {
    const target = targetPath(this.#root, entry.path);
    try {
      const status = await lstat(target);
      const identity = await this.#ownership.inspect(target);
      if (modeOf(status.mode) === entry.mode && sameIdentity(identity, entry.identity)) return;
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
    try {
      await mkdir(target, { mode: entry.mode });
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
    }
    await chmod(target, entry.mode);
    await this.#ownership.set(target, entry.identity);
  }

  async #file(entry: Extract<ImagePlanEntry, { kind: "file" }>): Promise<void> {
    const target = targetPath(this.#root, entry.path);
    const existing = await this.readOptional(entry.path);
    if (existing !== undefined) {
      const status = await lstat(target);
      const identity = await this.#ownership.inspect(target);
      if (
        Buffer.from(existing).equals(Buffer.from(entry.contents)) &&
        modeOf(status.mode) === entry.mode && sameIdentity(identity, entry.identity)
      ) return;
    }
    const temporary = join(dirname(target), `.${basename(target)}.agent-boot-${randomUUID()}`);
    let handle;
    try {
      handle = await open(
        temporary,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
        entry.mode,
      );
      await handle.writeFile(entry.contents);
      await handle.chmod(entry.mode);
      await handle.sync();
      await handle.close();
      handle = undefined;
      await this.#ownership.set(temporary, entry.identity);
      await rename(temporary, target);
      await this.#ownership.set(target, entry.identity);
      await syncDirectory(dirname(target));
    } finally {
      await handle?.close();
      await rm(temporary, { force: true });
    }
  }

  async #link(entry: Extract<ImagePlanEntry, { kind: "symlink" }>): Promise<void> {
    const target = targetPath(this.#root, entry.path);
    try {
      if (await readlink(target) === entry.linkTarget) {
        const identity = await this.#ownership.inspect(target, true);
        if (!sameIdentity(identity, entry.identity)) {
          await this.#ownership.set(target, entry.identity, true);
        }
        return;
      }
    } catch (error) {
      if (!isMissing(error) && !(error instanceof Error && "code" in error && error.code === "EINVAL")) {
        throw error;
      }
    }
    await symlink(entry.linkTarget, target);
    await this.#ownership.set(target, entry.identity, true);
    await syncDirectory(dirname(target));
  }
}

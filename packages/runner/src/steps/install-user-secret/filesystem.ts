import {
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  unlink,
} from "node:fs/promises";

export interface UserSecretFileStat {
  readonly dev: number;
  readonly gid: number;
  readonly ino: number;
  readonly mode: number;
  readonly nlink: number;
  readonly uid: number;
  isDirectory(): boolean;
  isFile(): boolean;
  isSymbolicLink(): boolean;
}

export interface UserSecretFileHandle {
  readonly descriptor: number;
  chmod(mode: number): Promise<void>;
  chown(uid: number, gid: number): Promise<void>;
  close(): Promise<void>;
  readFile(): Promise<Buffer>;
  stat(): Promise<UserSecretFileStat>;
  sync(): Promise<void>;
  writeFile(contents: Uint8Array): Promise<void>;
}

export interface UserSecretFileSystem {
  lstat(path: string): Promise<UserSecretFileStat>;
  lstatAt(directory: UserSecretFileHandle, name: string): Promise<UserSecretFileStat>;
  mkdirAt(
    directory: UserSecretFileHandle,
    name: string,
    options: { readonly mode: number },
  ): Promise<void>;
  open(path: string, flags: number, mode?: number): Promise<UserSecretFileHandle>;
  openAt(
    directory: UserSecretFileHandle,
    name: string,
    flags: number,
    mode?: number,
  ): Promise<UserSecretFileHandle>;
  readdirAt(directory: UserSecretFileHandle): Promise<string[]>;
  realpath(path: string): Promise<string>;
  renameAt(directory: UserSecretFileHandle, from: string, to: string): Promise<void>;
  unlink(path: string): Promise<void>;
  unlinkAt(directory: UserSecretFileHandle, name: string): Promise<void>;
}

export interface UserSecretOwnership {
  set(handle: UserSecretFileHandle, uid: number, gid: number): Promise<void>;
}

export class NodeUserSecretFileSystem implements UserSecretFileSystem {
  lstat(path: string): Promise<UserSecretFileStat> {
    return lstat(path);
  }

  lstatAt(directory: UserSecretFileHandle, name: string): Promise<UserSecretFileStat> {
    return lstat(this.#at(directory, name));
  }

  async mkdirAt(
    directory: UserSecretFileHandle,
    name: string,
    options: { readonly mode: number },
  ): Promise<void> {
    await mkdir(this.#at(directory, name), options);
  }

  open(path: string, flags: number, mode?: number): Promise<UserSecretFileHandle> {
    return this.#open(path, flags, mode);
  }

  openAt(
    directory: UserSecretFileHandle,
    name: string,
    flags: number,
    mode?: number,
  ): Promise<UserSecretFileHandle> {
    return this.#open(this.#at(directory, name), flags, mode);
  }

  readdirAt(directory: UserSecretFileHandle): Promise<string[]> {
    return readdir(this.#descriptorPath(directory));
  }

  realpath(path: string): Promise<string> {
    return realpath(path);
  }

  renameAt(directory: UserSecretFileHandle, from: string, to: string): Promise<void> {
    return rename(this.#at(directory, from), this.#at(directory, to));
  }

  unlink(path: string): Promise<void> {
    return unlink(path);
  }

  unlinkAt(directory: UserSecretFileHandle, name: string): Promise<void> {
    return unlink(this.#at(directory, name));
  }

  #at(directory: UserSecretFileHandle, name: string): string {
    if (name === "" || name === "." || name === ".." || name.includes("/")) {
      throw new TypeError("Descriptor-relative names must be single path segments.");
    }
    return `${this.#descriptorPath(directory)}/${name}`;
  }

  #descriptorPath(directory: UserSecretFileHandle): string {
    return `/proc/self/fd/${String(directory.descriptor)}`;
  }

  async #open(
    path: string,
    flags: number,
    mode?: number,
  ): Promise<UserSecretFileHandle> {
    const handle = mode === undefined ? await open(path, flags) : await open(path, flags, mode);
    return {
      descriptor: handle.fd,
      chmod: value => handle.chmod(value),
      chown: (uid, gid) => handle.chown(uid, gid),
      close: () => handle.close(),
      readFile: () => handle.readFile(),
      stat: () => handle.stat(),
      sync: () => handle.sync(),
      writeFile: contents => handle.writeFile(contents),
    };
  }
}

export class NodeUserSecretOwnership implements UserSecretOwnership {
  set(handle: UserSecretFileHandle, uid: number, gid: number): Promise<void> {
    return handle.chown(uid, gid);
  }
}

import {
  chmod,
  chown,
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
  close(): Promise<void>;
  readFile(): Promise<Buffer>;
  stat(): Promise<UserSecretFileStat>;
  sync(): Promise<void>;
  writeFile(contents: Uint8Array): Promise<void>;
}

export interface UserSecretFileSystem {
  chmod(path: string, mode: number): Promise<void>;
  lstat(path: string): Promise<UserSecretFileStat>;
  mkdir(path: string, options: { readonly mode: number }): Promise<void>;
  open(path: string, flags: number, mode?: number): Promise<UserSecretFileHandle>;
  readdir(path: string): Promise<string[]>;
  realpath(path: string): Promise<string>;
  rename(from: string, to: string): Promise<void>;
  unlink(path: string): Promise<void>;
}

export interface UserSecretOwnership {
  set(path: string, uid: number, gid: number): Promise<void>;
}

export class NodeUserSecretFileSystem implements UserSecretFileSystem {
  chmod(path: string, mode: number): Promise<void> {
    return chmod(path, mode);
  }

  lstat(path: string): Promise<UserSecretFileStat> {
    return lstat(path);
  }

  async mkdir(path: string, options: { readonly mode: number }): Promise<void> {
    await mkdir(path, options);
  }

  open(path: string, flags: number, mode?: number): Promise<UserSecretFileHandle> {
    return mode === undefined ? open(path, flags) : open(path, flags, mode);
  }

  readdir(path: string): Promise<string[]> {
    return readdir(path);
  }

  realpath(path: string): Promise<string> {
    return realpath(path);
  }

  rename(from: string, to: string): Promise<void> {
    return rename(from, to);
  }

  unlink(path: string): Promise<void> {
    return unlink(path);
  }
}

export class NodeUserSecretOwnership implements UserSecretOwnership {
  set(path: string, uid: number, gid: number): Promise<void> {
    return chown(path, uid, gid);
  }
}

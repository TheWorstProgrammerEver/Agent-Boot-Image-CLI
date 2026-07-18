import { open, lstat, mkdir, readdir, readFile, rename, unlink } from "node:fs/promises";

export interface StateFileHandle {
  close(): Promise<void>;
  sync(): Promise<void>;
  writeFile(data: string): Promise<void>;
}

export interface StateFileStat {
  readonly mode: number;
  readonly size: number;
  isFile(): boolean;
  isSymbolicLink(): boolean;
}

export interface StateFileSystem {
  lstat(path: string): Promise<StateFileStat>;
  mkdir(path: string, options: { readonly mode: number; readonly recursive: true }): Promise<unknown>;
  open(path: string, flags: number, mode?: number): Promise<StateFileHandle>;
  readFile(path: string, encoding: "utf8"): Promise<string>;
  readdir(path: string): Promise<string[]>;
  rename(from: string, to: string): Promise<void>;
  unlink(path: string): Promise<void>;
}

export class NodeStateFileSystem implements StateFileSystem {
  lstat(path: string): Promise<StateFileStat> {
    return lstat(path);
  }

  mkdir(path: string, options: { readonly mode: number; readonly recursive: true }): Promise<unknown> {
    return mkdir(path, options);
  }

  open(path: string, flags: number, mode?: number): Promise<StateFileHandle> {
    return mode === undefined ? open(path, flags) : open(path, flags, mode);
  }

  readFile(path: string, encoding: "utf8"): Promise<string> {
    return readFile(path, encoding);
  }

  readdir(path: string): Promise<string[]> {
    return readdir(path);
  }

  rename(from: string, to: string): Promise<void> {
    return rename(from, to);
  }

  unlink(path: string): Promise<void> {
    return unlink(path);
  }
}

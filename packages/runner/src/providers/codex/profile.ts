import { constants } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  rename,
  rm,
  type FileHandle,
} from "node:fs/promises";
import { basename, isAbsolute, join } from "node:path";
import { randomUUID } from "node:crypto";

import { CodexBootstrapError } from "./errors.js";

export const CODEX_PROFILE_CONTENT = [
  'approval_policy = "never"',
  'sandbox_mode = "danger-full-access"',
  "",
].join("\n");

export interface CodexProfileStore {
  ensure(): Promise<void>;
  verify(): Promise<boolean>;
}

export interface NodeCodexProfileStoreOptions {
  readonly codexHome: string;
  readonly gid: number;
  readonly profileName?: string;
  readonly uid: number;
}

const profileNamePattern = /^[A-Za-z0-9_-]+$/u;

const mode = (value: number): number => value & 0o777;

export class NodeCodexProfileStore implements CodexProfileStore {
  readonly #codexHome: string;
  readonly #gid: number;
  readonly #profilePath: string;
  readonly #uid: number;

  constructor(options: NodeCodexProfileStoreOptions) {
    const profileName = options.profileName ?? "agent-boot";
    if (!isAbsolute(options.codexHome) || options.codexHome.includes("\0")) {
      throw new TypeError("codexHome must be an absolute path without null bytes");
    }
    if (!profileNamePattern.test(profileName)) {
      throw new TypeError("profileName must contain only letters, numbers, underscores, or hyphens");
    }
    if (!Number.isSafeInteger(options.uid) || options.uid < 0) {
      throw new TypeError("uid must be a non-negative integer");
    }
    if (!Number.isSafeInteger(options.gid) || options.gid < 0) {
      throw new TypeError("gid must be a non-negative integer");
    }
    this.#codexHome = options.codexHome;
    this.#gid = options.gid;
    this.#profilePath = join(options.codexHome, `${profileName}.config.toml`);
    this.#uid = options.uid;
  }

  async ensure(): Promise<void> {
    if (await this.verify()) return;

    try {
      await mkdir(this.#codexHome, { mode: 0o700, recursive: true });
      const directory = await this.#openCodexHome();
      try {
        const directoryStat = await directory.stat();
        if (!directoryStat.isDirectory()) throw new Error("unsafe");
        await directory.chmod(0o700);
        await directory.chown(this.#uid, this.#gid);

        const profilePath = this.#anchoredPath(directory, basename(this.#profilePath));
        const existing = await this.#optionalStat(profilePath);
        if (existing !== undefined && (!existing.isFile() || existing.isSymbolicLink())) {
          throw new Error("unsafe");
        }

        const temporaryPath = this.#anchoredPath(
          directory,
          `.${randomUUID()}.${basename(this.#profilePath)}.tmp`,
        );
        try {
          const temporary = await open(temporaryPath, "wx", 0o600);
          try {
            await temporary.writeFile(CODEX_PROFILE_CONTENT, "utf8");
            await temporary.chmod(0o600);
            await temporary.chown(this.#uid, this.#gid);
            await temporary.sync();
          } finally {
            await temporary.close();
          }
          await rename(temporaryPath, profilePath);
          await directory.sync();
        } finally {
          await rm(temporaryPath, { force: true });
        }
      } finally {
        await directory.close();
      }
    } catch {
      throw new CodexBootstrapError("configuration");
    }

    if (!(await this.verify())) throw new CodexBootstrapError("configuration");
  }

  async verify(): Promise<boolean> {
    let directory: FileHandle | undefined;
    let profile: FileHandle | undefined;
    try {
      directory = await this.#openCodexHome();
      const directoryStat = await directory.stat();
      profile = await open(
        this.#anchoredPath(directory, basename(this.#profilePath)),
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
      const profileStat = await profile.stat();
      const contents = await profile.readFile("utf8");
      return directoryStat.isDirectory() &&
        mode(directoryStat.mode) === 0o700 &&
        directoryStat.uid === this.#uid &&
        directoryStat.gid === this.#gid &&
        profileStat.isFile() &&
        profileStat.nlink === 1 &&
        mode(profileStat.mode) === 0o600 &&
        profileStat.uid === this.#uid &&
        profileStat.gid === this.#gid &&
        contents === CODEX_PROFILE_CONTENT;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw new CodexBootstrapError("configuration");
    } finally {
      await Promise.allSettled([
        ...(profile === undefined ? [] : [profile.close()]),
        ...(directory === undefined ? [] : [directory.close()]),
      ]);
    }
  }

  #anchoredPath(directory: FileHandle, name: string): string {
    return `/proc/self/fd/${String(directory.fd)}/${name}`;
  }

  #openCodexHome(): Promise<FileHandle> {
    return open(
      this.#codexHome,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
  }

  async #optionalStat(path: string) {
    try {
      return await lstat(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }
}

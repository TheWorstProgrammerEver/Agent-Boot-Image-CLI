import { constants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  rename,
  rm,
} from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import { PromptJobOperationError, PromptJobUnitRecoveryError } from "./errors.js";
import { PROMPT_JOB_UNIT_PREFIX } from "./units.js";

export interface PromptJobUnitRegistry {
  readonly account: string;
  readonly enabled: boolean;
  readonly manifestPath: string;
  readonly timerNames: readonly string[];
  readonly unitNames: readonly string[];
  readonly version: 1;
}

export interface UnitPublicationHooks {
  readonly afterPublish: () => Promise<void>;
  readonly afterRollback?: () => Promise<void>;
}

const unitNamePattern = new RegExp(
  `^${PROMPT_JOB_UNIT_PREFIX}[a-z][a-z0-9-]{0,47}\\.(?:service|timer)$`,
  "u",
);

const writeExclusive = async (path: string, contents: string, mode: number): Promise<void> => {
  const handle = await open(
    path,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
    mode,
  );
  try {
    await handle.writeFile(contents);
    await handle.chmod(mode);
    await handle.sync();
  } finally {
    await handle.close();
  }
};

const assertUnitName = (name: string): void => {
  if (!unitNamePattern.test(name) || basename(name) !== name) {
    throw new PromptJobOperationError("The managed systemd unit name is unsafe.");
  }
};

const missing = (error: unknown): boolean =>
  (error as NodeJS.ErrnoException).code === "ENOENT";

const unitNames = (input: unknown): input is string[] =>
  Array.isArray(input) && input.every(name =>
    typeof name === "string" && unitNamePattern.test(name));

export class PromptJobUnitStore {
  readonly #registryDirectory: string;
  readonly #unitsDirectory: string;

  constructor(root = "/") {
    this.#registryDirectory = join(root, "var", "lib", "agent-boot", "prompt-jobs");
    this.#unitsDirectory = join(root, "etc", "systemd", "system");
  }

  registryPath(account: string): string {
    return join(this.#registryDirectory, `${account}.json`);
  }

  unitPath(name: string): string {
    assertUnitName(name);
    return join(this.#unitsDirectory, name);
  }

  async prepareUnitFiles(files: ReadonlyMap<string, string>): Promise<{
    readonly cleanup: () => Promise<void>;
    readonly paths: readonly string[];
  }> {
    await mkdir(this.#unitsDirectory, { recursive: true, mode: 0o755 });
    const staging = await mkdtemp(join(dirname(this.#unitsDirectory), ".prompt-jobs-verify-"));
    try {
      const paths: string[] = [];
      for (const [name, contents] of files) {
        assertUnitName(name);
        const path = join(staging, name);
        await writeExclusive(path, contents, 0o644);
        paths.push(path);
      }
      return { cleanup: () => rm(staging, { force: true, recursive: true }), paths };
    } catch (error) {
      await rm(staging, { force: true, recursive: true });
      throw error;
    }
  }

  async readRegistry(account: string): Promise<PromptJobUnitRegistry | undefined> {
    let input: unknown;
    try {
      input = JSON.parse(await readFile(this.registryPath(account), "utf8")) as unknown;
    } catch (error) {
      if (missing(error)) return undefined;
      throw new PromptJobOperationError("The installed prompt-job registry is unreadable.");
    }
    if (typeof input !== "object" || input === null || Array.isArray(input)) {
      throw new PromptJobOperationError("The installed prompt-job registry is invalid.");
    }
    const value = input as Record<string, unknown>;
    const timerNames = value.timerNames;
    const registeredUnitNames = value.unitNames;
    const keys = Object.keys(value).sort();
    const expectedKeys = [
      "account",
      "enabled",
      "manifestPath",
      "timerNames",
      "unitNames",
      "version",
    ];
    if (
      keys.join("\0") !== expectedKeys.join("\0") ||
      value.version !== 1 || value.account !== account || typeof value.enabled !== "boolean" ||
      typeof value.manifestPath !== "string" || !unitNames(timerNames) ||
      !unitNames(registeredUnitNames) ||
      new Set(timerNames).size !== timerNames.length ||
      new Set(registeredUnitNames).size !== registeredUnitNames.length ||
      !timerNames.every(name => registeredUnitNames.includes(name))
    ) throw new PromptJobOperationError("The installed prompt-job registry is invalid.");
    return {
      account,
      enabled: value.enabled,
      manifestPath: value.manifestPath,
      timerNames,
      unitNames: registeredUnitNames,
      version: 1,
    };
  }

  async writeRegistry(registry: PromptJobUnitRegistry): Promise<void> {
    await mkdir(this.#registryDirectory, { recursive: true, mode: 0o700 });
    await chmod(this.#registryDirectory, 0o700);
    const temporary = await mkdtemp(join(this.#registryDirectory, ".registry-"));
    const candidate = join(temporary, "registry.json");
    try {
      await writeExclusive(candidate, `${JSON.stringify(registry)}\n`, 0o600);
      await rename(candidate, this.registryPath(registry.account));
    } finally {
      await rm(temporary, { force: true, recursive: true });
    }
  }

  async removeRegistry(account: string): Promise<void> {
    await rm(this.registryPath(account), { force: true });
  }

  async publish(
    files: ReadonlyMap<string, string>,
    previousUnitNames: readonly string[],
    hooks: UnitPublicationHooks,
  ): Promise<void> {
    await mkdir(this.#unitsDirectory, { recursive: true, mode: 0o755 });
    const operation = await mkdtemp(join(dirname(this.#unitsDirectory), ".prompt-jobs-publish-"));
    const staging = join(operation, "staging");
    const backup = join(operation, "backup");
    await mkdir(staging, { mode: 0o700 });
    await mkdir(backup, { mode: 0o700 });
    const previous = new Set(previousUnitNames);
    const affected = new Set([...previous, ...files.keys()]);
    const moved = new Set<string>();
    const published = new Set<string>();
    for (const name of affected) assertUnitName(name);
    try {
      for (const [name, contents] of files) {
        await writeExclusive(join(staging, name), contents, 0o644);
      }
      try {
        for (const name of affected) {
          const target = this.unitPath(name);
          try {
            const metadata = await lstat(target);
            if (!previous.has(name) || metadata.isSymbolicLink() || !metadata.isFile()) {
              throw new PromptJobOperationError("A managed systemd unit target is unsafe or unowned.");
            }
            await rename(target, join(backup, name));
            moved.add(name);
          } catch (error) {
            if (!missing(error)) throw error;
          }
        }
        for (const name of files.keys()) {
          await rename(join(staging, name), this.unitPath(name));
          published.add(name);
        }
        await hooks.afterPublish();
      } catch (error) {
        for (const name of published) await rm(this.unitPath(name), { force: true });
        try {
          for (const name of moved) {
            await rename(join(backup, name), this.unitPath(name));
          }
        } catch {
          throw new PromptJobUnitRecoveryError(operation);
        }
        if (moved.size > 0 || published.size > 0) {
          await hooks.afterRollback?.();
        }
        throw error;
      }
    } catch (error) {
      if (!(error instanceof PromptJobUnitRecoveryError)) {
        await rm(operation, { force: true, recursive: true });
      }
      throw error;
    }
    await rm(operation, { force: true, recursive: true });
  }
}

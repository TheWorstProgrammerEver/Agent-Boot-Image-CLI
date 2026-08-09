import { constants } from "node:fs";
import { open, realpath, stat, type FileHandle } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { PromptJobValidationError } from "./errors.js";
import {
  type LoadedScheduledPromptJob,
  type LoadedScheduledPromptManifest,
} from "./model.js";
import { parseScheduledPromptManifest } from "./schema.js";

const MAX_MANIFEST_BYTES = 64 * 1_024;
const MAX_PROMPT_BYTES = 128 * 1_024;

export interface CalendarValidator {
  validate(expression: string): Promise<void>;
}

export interface LoadScheduledPromptManifestOptions {
  readonly accountUid: number;
  readonly calendarValidator: CalendarValidator;
  readonly homeDirectory: string;
  readonly manifestPath: string;
}

const fail = (path: string, reason: string): never => {
  throw new PromptJobValidationError(path, reason);
};

const isContained = (root: string, path: string): boolean => {
  const suffix = relative(root, path);
  return suffix !== ".." && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix);
};

const checkedRegularFile = async (
  path: string,
  expectedUid: number,
  maximumBytes: number,
  validationPath: string,
): Promise<Uint8Array> => {
  let handle: FileHandle | undefined;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const metadata = await handle.stat();
    if (
      !metadata.isFile() || metadata.uid !== expectedUid || metadata.nlink !== 1 ||
      (metadata.mode & 0o022) !== 0
    ) fail(validationPath, "Expected a private regular file owned by the target account.");
    if (metadata.size < 1 || metadata.size > maximumBytes) {
      fail(validationPath, `Expected 1-${String(maximumBytes)} bytes.`);
    }
    return await handle.readFile();
  } catch (error) {
    if (error instanceof PromptJobValidationError) throw error;
    return fail(validationPath, "The file is missing or unreadable.");
  } finally {
    await handle?.close();
  }
};

const checkedCanonicalPath = async (
  root: string,
  path: string,
  validationPath: string,
): Promise<string> => {
  let canonical: string;
  try {
    canonical = await realpath(path);
  } catch {
    return fail(validationPath, "The path is missing or unreadable.");
  }
  if (canonical !== resolve(path) || !isContained(root, canonical)) {
    fail(validationPath, "The path escapes its trusted root or contains a symbolic link.");
  }
  return canonical;
};

const checkedWorkingDirectory = async (
  home: string,
  relativePath: string,
  validationPath: string,
): Promise<string> => {
  const path = await checkedCanonicalPath(home, join(home, relativePath), validationPath);
  const metadata = await stat(path);
  if (!metadata.isDirectory()) fail(validationPath, "Expected an existing directory.");
  return path;
};

export const loadScheduledPromptManifest = async (
  options: LoadScheduledPromptManifestOptions,
): Promise<LoadedScheduledPromptManifest> => {
  if (!Number.isSafeInteger(options.accountUid) || options.accountUid < 0) {
    throw new TypeError("accountUid must be a non-negative integer");
  }
  const home = await realpath(options.homeDirectory);
  if (home !== resolve(options.homeDirectory)) {
    fail("$.homeDirectory", "The account home must not contain symbolic links.");
  }
  const manifestPath = await checkedCanonicalPath(
    home,
    options.manifestPath,
    "$.manifestPath",
  );
  const manifestBytes = await checkedRegularFile(
    manifestPath,
    options.accountUid,
    MAX_MANIFEST_BYTES,
    "$.manifestPath",
  );
  let input: unknown;
  try {
    input = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(manifestBytes)) as unknown;
  } catch {
    fail("$", "Expected valid UTF-8 JSON.");
  }
  const parsed = parseScheduledPromptManifest(input);
  const promptRoot = dirname(manifestPath);
  const jobs: LoadedScheduledPromptJob[] = [];
  for (const [index, job] of parsed.jobs.entries()) {
    const path = `$.jobs[${String(index)}]`;
    await options.calendarValidator.validate(job.onCalendar).catch(() => {
      fail(`${path}.onCalendar`, "systemd rejected the calendar expression.");
    });
    const promptPath = await checkedCanonicalPath(
      promptRoot,
      join(promptRoot, job.prompt),
      `${path}.prompt`,
    );
    await checkedRegularFile(
      promptPath,
      options.accountUid,
      MAX_PROMPT_BYTES,
      `${path}.prompt`,
    );
    const workingDirectoryPath = await checkedWorkingDirectory(
      home,
      job.workingDirectory,
      `${path}.workingDirectory`,
    );
    jobs.push({ ...job, promptPath, workingDirectoryPath });
  }
  return {
    jobs,
    manifestPath,
    promptRoot,
    version: parsed.version,
  };
};

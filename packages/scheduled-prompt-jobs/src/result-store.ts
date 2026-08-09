import { constants } from "node:fs";
import { chmod, mkdir, open, rename, rm, type FileHandle } from "node:fs/promises";
import { dirname, join } from "node:path";

export type PromptJobResult =
  | "failed"
  | "passed"
  | "skipped-overlap"
  | "timed-out";

export interface PromptJobLastRun {
  readonly exitCode?: number;
  readonly finishedAt: string;
  readonly jobId: string;
  readonly result: PromptJobResult;
  readonly runId?: string;
  readonly startedAt?: string;
  readonly version: 1;
}

const canonicalLine = (value: PromptJobLastRun): string => `${JSON.stringify(value)}\n`;
const results = new Set<PromptJobResult>(["failed", "passed", "skipped-overlap", "timed-out"]);
const MAX_RESULT_FILE_BYTES = 128 * 1_024;

const parseResult = (input: unknown): PromptJobLastRun => {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error("Prompt-job result state is invalid.");
  }
  const value = input as Record<string, unknown>;
  const keys = Object.keys(value).sort();
  const allowed = new Set([
    "exitCode", "finishedAt", "jobId", "result", "runId", "startedAt", "version",
  ]);
  const exitCode = value.exitCode;
  const runId = value.runId;
  const startedAt = value.startedAt;
  if (
    keys.some(key => !allowed.has(key)) || value.version !== 1 ||
    typeof value.finishedAt !== "string" || typeof value.jobId !== "string" ||
    !results.has(value.result as PromptJobResult) ||
    (runId !== undefined && (
      typeof runId !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(runId)
    )) ||
    (startedAt !== undefined && typeof startedAt !== "string") ||
    (exitCode !== undefined && (
      typeof exitCode !== "number" || !Number.isSafeInteger(exitCode) || exitCode < 0
    ))
  ) throw new Error("Prompt-job result state is invalid.");
  return {
    ...(exitCode === undefined ? {} : { exitCode }),
    finishedAt: value.finishedAt,
    jobId: value.jobId,
    result: value.result as PromptJobResult,
    ...(runId === undefined ? {} : { runId }),
    ...(startedAt === undefined ? {} : { startedAt }),
    version: 1,
  };
};

const readPrivateText = async (path: string): Promise<string> => {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const metadata = await handle.stat();
    if (
      !metadata.isFile() || metadata.nlink !== 1 || (metadata.mode & 0o077) !== 0 ||
      metadata.size > MAX_RESULT_FILE_BYTES
    ) throw new Error("Prompt-job result state is invalid.");
    return await handle.readFile("utf8");
  } finally {
    await handle.close();
  }
};

const atomicWrite = async (path: string, contents: string): Promise<void> => {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await chmod(dirname(path), 0o700);
  const temporary = join(dirname(path), `.last-run.${String(process.pid)}.${Date.now().toString(16)}`);
  let handle: FileHandle | undefined;
  try {
    handle = await open(
      temporary,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
      0o600,
    );
    await handle.writeFile(contents);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, path);
  } finally {
    await handle?.close();
    await rm(temporary, { force: true });
  }
};

export class PromptJobResultStore {
  readonly #root: string;

  constructor(root: string) {
    this.#root = root;
  }

  async record(result: PromptJobLastRun, retention: number): Promise<void> {
    const directory = join(this.#root, result.jobId);
    const statusPath = join(directory, "last-run.json");
    const logPath = join(directory, "runs.jsonl");
    let previous: string[] = [];
    try {
      previous = (await readPrivateText(logPath)).trimEnd().split("\n").filter(Boolean)
        .map(line => parseResult(JSON.parse(line) as unknown))
        .map(previousResult => {
          if (previousResult.jobId !== result.jobId) {
            throw new Error("Prompt-job result state is invalid.");
          }
          return JSON.stringify(previousResult);
        });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const retained = [...previous, JSON.stringify(result)].slice(-retention);
    await atomicWrite(statusPath, canonicalLine(result));
    await atomicWrite(logPath, retained.map(line => `${line}\n`).join(""));
  }

  async read(jobId: string): Promise<PromptJobLastRun | undefined> {
    try {
      const result = parseResult(JSON.parse(
        await readPrivateText(join(this.#root, jobId, "last-run.json")),
      ) as unknown);
      if (result.jobId !== jobId) throw new Error("Prompt-job result state is invalid.");
      return result;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }
}

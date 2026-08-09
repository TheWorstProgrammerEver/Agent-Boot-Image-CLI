import { readFile, realpath, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";

import type { SpawnHost, SpawnResult } from "@agent-boot/process";

import { PromptJobOperationError } from "./errors.js";
import type { LoadedScheduledPromptJob } from "./model.js";
import { promptWithExecutionPolicy } from "./policy.js";
import { PromptJobResultStore, type PromptJobLastRun } from "./result-store.js";

export interface PromptJobExecutionContext {
  readonly codexExecutable?: string;
  readonly homeDirectory: string;
  readonly now?: () => Date;
  readonly path?: string;
  readonly resultStore: PromptJobResultStore;
  readonly spawnHost: SpawnHost;
  readonly username: string;
}

const isContained = (root: string, path: string): boolean => {
  const suffix = relative(root, path);
  return suffix !== ".." && !suffix.startsWith(`..${sep}`);
};

const executableFor = async (context: PromptJobExecutionContext): Promise<string> => {
  if (context.codexExecutable !== undefined) return context.codexExecutable;
  const trustedRoot = await realpath(join(context.homeDirectory, ".local"));
  const candidate = await realpath(join(trustedRoot, "bin", "codex"));
  const metadata = await stat(candidate);
  if (!isContained(trustedRoot, candidate) || !metadata.isFile() || (metadata.mode & 0o111) === 0) {
    throw new PromptJobOperationError("The scheduled Codex launcher failed its file checks.");
  }
  return candidate;
};

const codexArguments = (job: LoadedScheduledPromptJob): readonly string[] => [
  "exec",
  "--model",
  job.model,
  "-c",
  `model_reasoning_effort=${JSON.stringify(job.reasoningEffort)}`,
  "--dangerously-bypass-approvals-and-sandbox",
  "--skip-git-repo-check",
  "-C",
  job.workingDirectoryPath,
  "-",
];

const resultDocument = (
  job: LoadedScheduledPromptJob,
  startedAt: string,
  finishedAt: string,
  result: SpawnResult,
): PromptJobLastRun => ({
  ...(result.exitCode === null ? {} : { exitCode: result.exitCode }),
  finishedAt,
  jobId: job.id,
  result: result.reason === "timeout"
    ? "timed-out"
    : result.reason === "exit" && result.exitCode === 0
      ? "passed"
      : "failed",
  startedAt,
  version: 1,
});

export const executePromptJob = async (
  job: LoadedScheduledPromptJob,
  context: PromptJobExecutionContext,
): Promise<PromptJobLastRun> => {
  const now = context.now ?? (() => new Date());
  const startedAt = now().toISOString();
  const prompt = promptWithExecutionPolicy(job.effectPolicy, await readFile(job.promptPath));
  const executable = await executableFor(context);
  const path = context.path ?? [
    join(context.homeDirectory, ".local", "bin"),
    "/opt/agent-boot/runtime/bin",
    "/usr/local/sbin",
    "/usr/local/bin",
    "/usr/sbin",
    "/usr/bin",
    "/sbin",
    "/bin",
  ].join(":");
  const running = context.spawnHost.spawn({
    arguments: codexArguments(job),
    cwd: job.workingDirectoryPath,
    environment: {
      CODEX_HOME: join(context.homeDirectory, ".codex"),
      GIT_TERMINAL_PROMPT: "0",
      HOME: context.homeDirectory,
      LANG: "C.UTF-8",
      LOGNAME: context.username,
      PATH: path,
      SHELL: "/bin/bash",
      USER: context.username,
    },
    environmentMode: "replace",
    executable,
    forwardSignals: ["SIGHUP", "SIGINT", "SIGTERM"],
    label: `scheduled prompt job ${job.id}`,
    lifetime: { policy: "managed" },
    onOutput: () => undefined,
    stdin: prompt,
    stdio: "stream",
    timeoutMs: job.timeoutSeconds * 1_000,
  });
  const completion = await running.completion;
  const result = resultDocument(job, startedAt, now().toISOString(), completion);
  await context.resultStore.record(result, job.logRetention);
  return result;
};

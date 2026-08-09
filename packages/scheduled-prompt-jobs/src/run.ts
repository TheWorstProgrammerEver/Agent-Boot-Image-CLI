import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";

import { executePromptJob } from "./executor.js";
import type { PromptJobLastRun } from "./result-store.js";
import {
  jobFrom,
  loadRuntimeManifest,
  resultStoreFor,
  runtimeDependencies,
  type PromptJobRuntime,
} from "./runtime.js";
import { PROMPT_JOB_COMMAND } from "./units.js";

const lockedExitCode = (result: PromptJobLastRun): number =>
  result.result === "passed" ? 0 : result.result === "timed-out" ? 71 : 70;

export const runLockedPromptJob = async (
  runtime: PromptJobRuntime,
  jobId: string,
  options: { codexExecutable?: string; now?: () => Date } = {},
): Promise<number> => {
  const { spawnHost, systemd } = runtimeDependencies(runtime);
  const manifest = await loadRuntimeManifest(runtime, systemd);
  const job = jobFrom(manifest, jobId);
  const result = await executePromptJob(job, {
    ...(options.codexExecutable === undefined ? {} : { codexExecutable: options.codexExecutable }),
    homeDirectory: runtime.account.homeDirectory,
    ...(options.now === undefined ? {} : { now: options.now }),
    resultStore: resultStoreFor(runtime.account),
    spawnHost,
    username: runtime.account.username,
  });
  return lockedExitCode(result);
};

export const runPromptJob = async (
  runtime: PromptJobRuntime,
  jobId: string,
  options: { launcher?: string } = {},
): Promise<number> => {
  const { spawnHost, systemd } = runtimeDependencies(runtime);
  const manifest = await loadRuntimeManifest(runtime, systemd);
  const job = jobFrom(manifest, jobId);
  const stateRoot = join(runtime.account.homeDirectory, ".local", "state", "agent-boot-prompt-jobs");
  const lockRoot = join(stateRoot, "locks");
  await mkdir(lockRoot, { recursive: true, mode: 0o700 });
  const launcher = options.launcher ?? PROMPT_JOB_COMMAND;
  const running = spawnHost.spawn({
    arguments: [
      "--nonblock", "--conflict-exit-code", "75", join(lockRoot, `job-${job.id}.lock`),
      "/usr/bin/flock",
      "--nonblock", "--conflict-exit-code", "75", join(lockRoot, `group-${job.overlapGroup}.lock`),
      launcher,
      "run-locked", "--account", runtime.account.username,
      "--manifest", resolve(runtime.manifestPath), "--job", job.id,
    ],
    environment: {
      HOME: runtime.account.homeDirectory,
      LANG: "C.UTF-8",
      LOGNAME: runtime.account.username,
      PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
      USER: runtime.account.username,
    },
    environmentMode: "replace",
    executable: "/usr/bin/flock",
    forwardSignals: ["SIGHUP", "SIGINT", "SIGTERM"],
    label: `lock scheduled prompt job ${job.id}`,
    lifetime: { policy: "managed" },
    onOutput: () => undefined,
    stdio: "stream",
    timeoutMs: (job.timeoutSeconds + 45) * 1_000,
  });
  const completion = await running.completion;
  if (completion.reason === "exit" && completion.exitCode === 0) return 0;
  if (completion.reason === "exit" && completion.exitCode === 75) {
    await resultStoreFor(runtime.account).record({
      finishedAt: new Date().toISOString(),
      jobId: job.id,
      result: "skipped-overlap",
      version: 1,
    }, job.logRetention);
    return 0;
  }
  if (completion.reason === "exit" && (completion.exitCode === 70 || completion.exitCode === 71)) {
    return completion.exitCode;
  }
  await resultStoreFor(runtime.account).record({
    finishedAt: new Date().toISOString(),
    jobId: job.id,
    result: completion.reason === "timeout" ? "timed-out" : "failed",
    version: 1,
  }, job.logRetention);
  return completion.reason === "timeout" ? 71 : 70;
};

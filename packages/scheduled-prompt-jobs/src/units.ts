import { join } from "node:path";

import { PromptJobOperationError } from "./errors.js";
import type { LoadedScheduledPromptManifest, LoadedScheduledPromptJob } from "./model.js";

export const PROMPT_JOB_COMMAND = "/usr/local/sbin/agent-boot-prompt-jobs";
export const PROMPT_JOB_UNIT_PREFIX = "agent-boot-prompt-job-";

export interface PromptJobAccount {
  readonly gid: number;
  readonly group: string;
  readonly homeDirectory: string;
  readonly uid: number;
  readonly username: string;
}

export interface UnitDocuments {
  readonly files: ReadonlyMap<string, string>;
  readonly serviceNames: readonly string[];
  readonly timerNames: readonly string[];
}

const accountName = /^[a-z_][a-z0-9_-]{0,31}$/u;
const safeAbsolutePath = /^\/(?:[A-Za-z0-9._-]+\/?)+$/u;

const assertAccount = (account: PromptJobAccount): void => {
  if (!accountName.test(account.username) || !accountName.test(account.group)) {
    throw new PromptJobOperationError("Prompt-job account names are unsafe for systemd.");
  }
  if (!safeAbsolutePath.test(account.homeDirectory)) {
    throw new PromptJobOperationError("Prompt-job account home is unsafe for systemd.");
  }
};

export const serviceNameFor = (jobId: string): string =>
  `${PROMPT_JOB_UNIT_PREFIX}${jobId}.service`;

export const timerNameFor = (jobId: string): string =>
  `${PROMPT_JOB_UNIT_PREFIX}${jobId}.timer`;

const renderService = (
  job: LoadedScheduledPromptJob,
  manifestPath: string,
  account: PromptJobAccount,
): string => {
  for (const path of [manifestPath, job.workingDirectoryPath]) {
    if (!safeAbsolutePath.test(path)) {
      throw new PromptJobOperationError("Prompt-job paths are unsafe for systemd.");
    }
  }
  const path = [
    join(account.homeDirectory, ".local", "bin"),
    "/opt/agent-boot/runtime/bin",
    "/usr/local/sbin",
    "/usr/local/bin",
    "/usr/sbin",
    "/usr/bin",
    "/sbin",
    "/bin",
  ].join(":");
  return [
    "[Unit]",
    `Description=Agent Boot scheduled prompt job: ${job.id}`,
    "Wants=network-online.target",
    "After=network-online.target",
    "",
    "[Service]",
    "Type=oneshot",
    `User=${account.username}`,
    `Group=${account.group}`,
    `WorkingDirectory=${job.workingDirectoryPath}`,
    `Environment=HOME=${account.homeDirectory}`,
    `Environment=PATH=${path}`,
    "Environment=LANG=C.UTF-8",
    "Environment=GIT_TERMINAL_PROMPT=0",
    `ExecStart=${PROMPT_JOB_COMMAND} run --account ${account.username} --manifest ${manifestPath} --job ${job.id}`,
    `TimeoutStartSec=${String(job.timeoutSeconds + 60)}s`,
    "TimeoutStopSec=30s",
    "KillMode=control-group",
    "KillSignal=SIGTERM",
    "UMask=0077",
    "Nice=10",
    "IOSchedulingClass=best-effort",
    "IOSchedulingPriority=7",
    "StandardInput=null",
    "StandardOutput=journal",
    "StandardError=journal",
    `SyslogIdentifier=${PROMPT_JOB_UNIT_PREFIX}${job.id}`,
    "",
  ].join("\n");
};

const renderTimer = (job: LoadedScheduledPromptJob): string => [
  "[Unit]",
  `Description=Schedule Agent Boot prompt job: ${job.id}`,
  "",
  "[Timer]",
  `OnCalendar=${job.onCalendar}`,
  `RandomizedDelaySec=${String(job.randomizedDelaySeconds)}s`,
  `Persistent=${job.persistent ? "true" : "false"}`,
  "AccuracySec=1m",
  `Unit=${serviceNameFor(job.id)}`,
  "",
  "[Install]",
  "WantedBy=timers.target",
  "",
].join("\n");

export const renderPromptJobUnits = (
  manifest: LoadedScheduledPromptManifest,
  account: PromptJobAccount,
): UnitDocuments => {
  assertAccount(account);
  const files = new Map<string, string>();
  const serviceNames: string[] = [];
  const timerNames: string[] = [];
  for (const job of manifest.jobs) {
    const serviceName = serviceNameFor(job.id);
    const timerName = timerNameFor(job.id);
    files.set(serviceName, renderService(job, manifest.manifestPath, account));
    files.set(timerName, renderTimer(job));
    serviceNames.push(serviceName);
    timerNames.push(timerName);
  }
  return { files, serviceNames, timerNames };
};

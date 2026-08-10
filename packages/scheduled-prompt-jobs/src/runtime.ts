import { join } from "node:path";

import { NodeSpawnAdapter, type SpawnHost } from "@agent-boot/process";

import { PromptJobOperationError } from "./errors.js";
import { loadScheduledPromptManifest } from "./manifest.js";
import type { LoadedScheduledPromptJob, LoadedScheduledPromptManifest } from "./model.js";
import { PromptJobResultStore } from "./result-store.js";
import { CommandSystemdControl, type SystemdControl } from "./systemd-control.js";
import { PromptJobUnitStore } from "./unit-store.js";
import type { PromptJobAccount } from "./units.js";

export interface PromptJobRuntime {
  readonly account: PromptJobAccount;
  readonly manifestPath: string;
  readonly spawnHost?: SpawnHost;
  readonly systemd?: SystemdControl;
  readonly unitStore?: PromptJobUnitStore;
}

export const runtimeDependencies = (runtime: PromptJobRuntime) => {
  const spawnHost = runtime.spawnHost ?? new NodeSpawnAdapter({ terminationGraceMs: 15_000 });
  return {
    spawnHost,
    systemd: runtime.systemd ?? new CommandSystemdControl(spawnHost),
    unitStore: runtime.unitStore ?? new PromptJobUnitStore(),
  };
};

export const loadRuntimeManifest = async (
  runtime: PromptJobRuntime,
  systemd: SystemdControl,
): Promise<LoadedScheduledPromptManifest> => loadScheduledPromptManifest({
  accountUid: runtime.account.uid,
  calendarValidator: systemd,
  homeDirectory: runtime.account.homeDirectory,
  manifestPath: runtime.manifestPath,
});

export const resultStoreFor = (account: PromptJobAccount): PromptJobResultStore =>
  new PromptJobResultStore(join(account.homeDirectory, ".local", "state", "agent-boot-prompt-jobs"));

export const jobFrom = (
  manifest: LoadedScheduledPromptManifest,
  jobId: string,
): LoadedScheduledPromptJob => {
  const job = manifest.jobs.find(candidate => candidate.id === jobId);
  if (job === undefined) throw new PromptJobOperationError("The prompt job is not configured.");
  return job;
};

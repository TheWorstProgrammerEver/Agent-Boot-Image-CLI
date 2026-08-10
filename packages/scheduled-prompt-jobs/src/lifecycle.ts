import { PromptJobOperationError } from "./errors.js";
import type { PromptJobLastRun } from "./result-store.js";
import {
  jobFrom,
  loadRuntimeManifest,
  resultStoreFor,
  runtimeDependencies,
  type PromptJobRuntime,
} from "./runtime.js";
import { hasFiniteNextTrigger, type SystemdControl, type TimerState } from "./systemd-control.js";
import type { PromptJobUnitRegistry } from "./unit-store.js";
import { renderPromptJobUnits, serviceNameFor, timerNameFor } from "./units.js";

export interface PromptJobStatus {
  readonly id: string;
  readonly lastRun?: PromptJobLastRun;
  readonly timer: TimerState;
}

const assertTimerReady = async (systemd: SystemdControl, name: string): Promise<void> => {
  const state = await systemd.timerState(name);
  if (!state.enabled || !state.active || !hasFiniteNextTrigger(state)) {
    throw new PromptJobOperationError("An enabled prompt-job timer is not active and finitely armed.");
  }
};

const disableAndAssertTimer = async (systemd: SystemdControl, name: string): Promise<void> => {
  await systemd.disableTimer(name);
  const state = await systemd.timerState(name);
  if (state.enabled || state.active) {
    throw new PromptJobOperationError("A disabled prompt-job timer remained active.");
  }
};

const restoreTimerPolicy = async (
  systemd: SystemdControl,
  previous: PromptJobUnitRegistry | undefined,
  attemptedTimerNames: readonly string[] = [],
): Promise<void> => {
  for (const timer of attemptedTimerNames) await disableAndAssertTimer(systemd, timer);
  await systemd.daemonReload();
  if (previous === undefined) return;
  for (const timer of previous.timerNames) {
    if (previous.enabled) {
      await systemd.enableTimer(timer);
      await systemd.restartTimer(timer);
    } else await disableAndAssertTimer(systemd, timer);
  }
};

export const installPromptJobs = async (
  runtime: PromptJobRuntime,
  enabled: boolean,
): Promise<void> => {
  const { systemd, unitStore } = runtimeDependencies(runtime);
  const manifest = await loadRuntimeManifest(runtime, systemd);
  const units = renderPromptJobUnits(manifest, runtime.account);
  const prepared = await unitStore.prepareUnitFiles(units.files);
  try {
    await systemd.verifyUnits(prepared.paths);
  } finally {
    await prepared.cleanup();
  }
  const previous = await unitStore.readRegistry(runtime.account.username);
  const desiredTimers = new Set(units.timerNames);
  const staleTimers = previous?.timerNames.filter(name => !desiredTimers.has(name)) ?? [];
  const registry: PromptJobUnitRegistry = {
    account: runtime.account.username,
    enabled,
    manifestPath: manifest.manifestPath,
    timerNames: units.timerNames,
    unitNames: [...units.files.keys()],
    version: 1,
  };
  await unitStore.publish(units.files, previous?.unitNames ?? [], {
    afterPublish: async () => {
      for (const timer of staleTimers) await disableAndAssertTimer(systemd, timer);
      await systemd.daemonReload();
      for (const timer of units.timerNames) {
        if (enabled) {
          await systemd.enableTimer(timer);
          await systemd.restartTimer(timer);
          await assertTimerReady(systemd, timer);
        } else await disableAndAssertTimer(systemd, timer);
      }
      await unitStore.writeRegistry(registry);
    },
    afterRollback: () => restoreTimerPolicy(systemd, previous, units.timerNames),
  });
};

export const uninstallPromptJobs = async (runtime: PromptJobRuntime): Promise<void> => {
  const { systemd, unitStore } = runtimeDependencies(runtime);
  const previous = await unitStore.readRegistry(runtime.account.username);
  if (previous === undefined) return;
  await unitStore.publish(new Map(), previous.unitNames, {
    afterPublish: async () => {
      for (const timer of previous.timerNames) await disableAndAssertTimer(systemd, timer);
      await systemd.daemonReload();
      await unitStore.removeRegistry(runtime.account.username);
    },
    afterRollback: () => restoreTimerPolicy(systemd, previous),
  });
};

export const promptJobStatus = async (runtime: PromptJobRuntime): Promise<readonly PromptJobStatus[]> => {
  const { systemd } = runtimeDependencies(runtime);
  const manifest = await loadRuntimeManifest(runtime, systemd);
  const resultStore = resultStoreFor(runtime.account);
  return Promise.all(manifest.jobs.map(async job => {
    const lastRun = await resultStore.read(job.id);
    return {
      id: job.id,
      ...(lastRun === undefined ? {} : { lastRun }),
      timer: await systemd.timerState(timerNameFor(job.id)),
    };
  }));
};

export const runOnce = async (
  runtime: PromptJobRuntime,
  jobId: string,
  canary = false,
): Promise<PromptJobLastRun> => {
  const { systemd } = runtimeDependencies(runtime);
  const manifest = await loadRuntimeManifest(runtime, systemd);
  const job = jobFrom(manifest, jobId);
  const resultStore = resultStoreFor(runtime.account);
  const previousRunId = (await resultStore.read(job.id))?.runId;
  await systemd.startService(serviceNameFor(job.id));
  const result = await resultStore.read(job.id);
  if (result?.runId === undefined || result.runId === previousRunId) {
    throw new PromptJobOperationError("The prompt-job service did not record a fresh result.");
  }
  if (canary && result.result !== "passed") {
    throw new PromptJobOperationError("The prompt-job canary did not record a passing result.");
  }
  return result;
};

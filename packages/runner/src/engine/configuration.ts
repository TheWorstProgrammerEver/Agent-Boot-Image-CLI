import { runnerPlanSchema, type RunnerPlan } from "@agent-boot/protocol";

import { RunnerConfigurationError, RunnerPlanError } from "./errors.js";
import type {
  AutomaticStepPolicy,
  ManualStepPolicy,
  ProviderStepPolicy,
} from "./model.js";

const MAX_AUTOMATIC_ATTEMPTS = 100;
const MAX_AUTOMATIC_TIMEOUT_MS = 24 * 60 * 60 * 1_000;
const MAX_MANUAL_POLL_INTERVAL_MS = 24 * 60 * 60 * 1_000;
const MAX_MANUAL_CHECK_TIMEOUT_MS = 60 * 60 * 1_000;
const MAX_PROVIDER_TIMEOUT_MS = 24 * 60 * 60 * 1_000;

const validatePositiveInteger = (field: string, value: number, maximum: number): void => {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new RunnerConfigurationError(
      field,
      `expected an integer from 1 through ${String(maximum)}`,
    );
  }
};

export const validateAutomaticPolicy = (policy: AutomaticStepPolicy): void => {
  validatePositiveInteger(
    "automaticPolicy.maxAttempts",
    policy.maxAttempts,
    MAX_AUTOMATIC_ATTEMPTS,
  );
  validatePositiveInteger(
    "automaticPolicy.timeoutMs",
    policy.timeoutMs,
    MAX_AUTOMATIC_TIMEOUT_MS,
  );
};

export const validateManualPolicy = (policy: ManualStepPolicy): void => {
  validatePositiveInteger(
    "manualPolicy.completionCheckTimeoutMs",
    policy.completionCheckTimeoutMs,
    MAX_MANUAL_CHECK_TIMEOUT_MS,
  );
  validatePositiveInteger(
    "manualPolicy.maximumPollIntervalMs",
    policy.maximumPollIntervalMs,
    MAX_MANUAL_POLL_INTERVAL_MS,
  );
};

export const validateProviderPolicy = (policy: ProviderStepPolicy): void => {
  validatePositiveInteger(
    "providerPolicy.timeoutMs",
    policy.timeoutMs,
    MAX_PROVIDER_TIMEOUT_MS,
  );
};

export const loadRunnerPlan = (serialized: string | Uint8Array): RunnerPlan => {
  let document: unknown;
  try {
    const contents =
      typeof serialized === "string"
        ? serialized
        : new TextDecoder("utf-8", { fatal: true }).decode(serialized);
    document = JSON.parse(contents);
  } catch {
    throw new RunnerPlanError("invalid-json");
  }
  try {
    return runnerPlanSchema.parse(document);
  } catch {
    throw new RunnerPlanError("invalid-plan");
  }
};

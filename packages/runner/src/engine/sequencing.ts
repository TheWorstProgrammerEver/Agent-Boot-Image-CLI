import type { RunnerStep } from "@agent-boot/protocol";

import type { RunnerCheckpoint, RunnerDiagnostic } from "../state/index.js";

export const findUnsupportedStep = (
  steps: readonly RunnerStep[],
  support: { readonly prompt: boolean; readonly provider: boolean } = {
    prompt: false,
    provider: false,
  },
): RunnerStep | undefined =>
  steps.find(
    (step) =>
      step.kind !== "environment" &&
      step.kind !== "automatic" &&
      step.kind !== "manual" &&
      !(step.kind === "prompt" && support.prompt) &&
      !(step.kind === "provider" && support.provider),
  );

export const findRecoveryConflict = (
  state: RunnerCheckpoint,
  steps: readonly RunnerStep[],
): RunnerDiagnostic | undefined => {
  const current = state.currentStep;
  if (current === null) return undefined;
  const planned = steps[current.index];
  if (planned !== undefined && planned.id === current.id) return undefined;
  return {
    code: "manual-intervention-required",
    recovery: "manual-intervention",
    stepId: current.id,
  };
};

export interface PendingStep {
  readonly attempt: number;
  readonly index: number;
  readonly shouldCheckpointStart: boolean;
}

export const nextPendingStep = (
  state: RunnerCheckpoint,
  stepCount: number,
  maxAttempts: number,
): PendingStep | "complete" | "exhausted" => {
  const current = state.currentStep;
  if (current === null) return stepCount === 0
    ? "complete"
    : { attempt: 1, index: 0, shouldCheckpointStart: true };
  if (current.phase === "succeeded") {
    return current.index + 1 === stepCount
      ? "complete"
      : { attempt: 1, index: current.index + 1, shouldCheckpointStart: true };
  }
  if (current.phase === "started") {
    return current.attempt > maxAttempts
      ? "exhausted"
      : { attempt: current.attempt, index: current.index, shouldCheckpointStart: false };
  }
  return current.attempt >= maxAttempts
    ? "exhausted"
    : { attempt: current.attempt + 1, index: current.index, shouldCheckpointStart: true };
};

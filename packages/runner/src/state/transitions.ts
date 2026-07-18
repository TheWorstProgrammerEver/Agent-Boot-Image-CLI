import { StateTransitionError } from "./errors.js";
import {
  RUNNER_CHECKPOINT_SCHEMA_VERSION,
  type RunnerCheckpoint,
  type RunnerDiagnostic,
  type RunnerPlanIdentity,
  type SecretTransactionCheckpoint,
  type StepCheckpoint,
} from "./model.js";
import { parseRunnerCheckpoint } from "./schema.js";

const changed = (
  state: RunnerCheckpoint,
  updatedAt: string,
  patch: Partial<RunnerCheckpoint>,
): RunnerCheckpoint =>
  parseRunnerCheckpoint({
    ...state,
    ...patch,
    revision: state.revision + 1,
    updatedAt,
  });

export const initializeCheckpoint = (
  plan: RunnerPlanIdentity,
  updatedAt: string,
): RunnerCheckpoint =>
  parseRunnerCheckpoint({
    currentStep: null,
    plan,
    revision: 0,
    schemaVersion: RUNNER_CHECKPOINT_SCHEMA_VERSION,
    secretTransaction: null,
    terminal: null,
    updatedAt,
  });

const sameStep = (left: StepCheckpoint, right: StepCheckpoint): boolean =>
  left.attempt === right.attempt &&
  left.id === right.id &&
  left.index === right.index &&
  left.phase === right.phase;

const requireActive = (state: RunnerCheckpoint): void => {
  if (state.terminal !== null) {
    throw new StateTransitionError("terminal checkpoints are immutable");
  }
};

export const transitionStep = (
  state: RunnerCheckpoint,
  target: StepCheckpoint,
  updatedAt: string,
): RunnerCheckpoint => {
  requireActive(state);
  const current = state.currentStep;
  if (current === null) {
    if (target.index !== 0 || target.attempt !== 1 || target.phase !== "started") {
      throw new StateTransitionError("the first step must start at index 0 on attempt 1");
    }
    return changed(state, updatedAt, { currentStep: target });
  }
  if (sameStep(current, target)) return state;

  const sameIdentity = current.id === target.id && current.index === target.index;
  if (sameIdentity) {
    const completesAttempt =
      current.phase === "started" &&
      target.attempt === current.attempt &&
      (target.phase === "succeeded" || target.phase === "failed");
    const retriesAttempt =
      current.phase === "failed" &&
      target.phase === "started" &&
      target.attempt === current.attempt + 1;
    if (!completesAttempt && !retriesAttempt) {
      throw new StateTransitionError("step attempts and phases must advance monotonically");
    }
    if (
      target.phase === "succeeded" &&
      state.secretTransaction !== null &&
      state.secretTransaction.phase !== "committed"
    ) {
      throw new StateTransitionError("a secret transaction must be committed before its step succeeds");
    }
    return changed(state, updatedAt, { currentStep: target });
  }

  const advancesStep =
    current.phase === "succeeded" &&
    target.index === current.index + 1 &&
    target.attempt === 1 &&
    target.phase === "started";
  if (!advancesStep) {
    throw new StateTransitionError("a new step must immediately follow a succeeded step");
  }
  if (state.secretTransaction !== null && state.secretTransaction.phase !== "committed") {
    throw new StateTransitionError("cannot advance with an incomplete secret transaction");
  }
  return changed(state, updatedAt, { currentStep: target, secretTransaction: null });
};

const transactionPhases = ["prepared", "installed", "source-removed", "committed"] as const;

const sameTransactionIdentity = (
  left: SecretTransactionCheckpoint,
  right: SecretTransactionCheckpoint,
): boolean =>
  left.destination === right.destination &&
  left.secretId === right.secretId &&
  left.stepId === right.stepId;

export const transitionSecretTransaction = (
  state: RunnerCheckpoint,
  target: SecretTransactionCheckpoint,
  updatedAt: string,
): RunnerCheckpoint => {
  requireActive(state);
  const step = state.currentStep;
  if (step === null || step.phase !== "started" || step.id !== target.stepId) {
    throw new StateTransitionError("a secret transaction requires its active started step");
  }
  const current = state.secretTransaction;
  if (current === null) {
    if (target.phase !== "prepared") {
      throw new StateTransitionError("a secret transaction must begin in the prepared phase");
    }
    return changed(state, updatedAt, { secretTransaction: target });
  }
  if (!sameTransactionIdentity(current, target)) {
    throw new StateTransitionError("an active secret transaction cannot change identity");
  }
  if (current.phase === target.phase) return state;
  const currentIndex = transactionPhases.indexOf(current.phase);
  const targetIndex = transactionPhases.indexOf(target.phase);
  if (targetIndex !== currentIndex + 1) {
    throw new StateTransitionError("secret transaction phases must advance one checkpoint at a time");
  }
  return changed(state, updatedAt, { secretTransaction: target });
};

const sameDiagnostic = (left: RunnerDiagnostic, right: RunnerDiagnostic): boolean =>
  left.attempt === right.attempt &&
  left.code === right.code &&
  left.exitCode === right.exitCode &&
  left.recovery === right.recovery &&
  left.signal === right.signal &&
  left.stepId === right.stepId;

export const transitionTerminalSuccess = (
  state: RunnerCheckpoint,
  updatedAt: string,
): RunnerCheckpoint => {
  if (state.terminal?.status === "succeeded") return state;
  requireActive(state);
  if (state.currentStep !== null && state.currentStep.phase !== "succeeded") {
    throw new StateTransitionError("success requires the current step to have succeeded");
  }
  if (state.secretTransaction !== null && state.secretTransaction.phase !== "committed") {
    throw new StateTransitionError("success requires the secret transaction to be committed");
  }
  return changed(state, updatedAt, { terminal: { at: updatedAt, status: "succeeded" } });
};

export const transitionTerminalFailure = (
  state: RunnerCheckpoint,
  diagnostic: RunnerDiagnostic,
  updatedAt: string,
): RunnerCheckpoint => {
  if (
    state.terminal?.status === "failed" &&
    sameDiagnostic(state.terminal.diagnostic, diagnostic)
  ) {
    return state;
  }
  requireActive(state);
  return changed(state, updatedAt, {
    terminal: { at: updatedAt, diagnostic, status: "failed" },
  });
};

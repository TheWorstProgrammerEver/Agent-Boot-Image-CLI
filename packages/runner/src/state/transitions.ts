import { StateTransitionError } from "./errors.js";
import {
  RUNNER_CHECKPOINT_SCHEMA_VERSION,
  type FireAndForgetProcessCheckpoint,
  type FireAndForgetProcessEvent,
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
    fireAndForgetProcesses: [],
    plan,
    revision: 0,
    schemaVersion: RUNNER_CHECKPOINT_SCHEMA_VERSION,
    secretTransaction: null,
    terminal: null,
    updatedAt,
  });

const sameProcessIdentity = (
  left: FireAndForgetProcessCheckpoint["identity"],
  right: FireAndForgetProcessCheckpoint["identity"],
): boolean =>
  left.bootId === right.bootId &&
  left.pid === right.pid &&
  left.processGroupId === right.processGroupId &&
  left.startTimeTicks === right.startTimeTicks;

const sameProcessEvent = (
  process: FireAndForgetProcessCheckpoint,
  event: FireAndForgetProcessEvent,
): boolean =>
  process.generation === event.generation &&
  process.stepId === event.stepId &&
  process.stepIndex === event.stepIndex &&
  sameProcessIdentity(process.identity, event.identity);

export const transitionFireAndForgetProcess = (
  state: RunnerCheckpoint,
  event: FireAndForgetProcessEvent,
  updatedAt: string,
): RunnerCheckpoint => {
  const index = state.fireAndForgetProcesses.findIndex(
    (process) => process.stepId === event.stepId,
  );
  const current = state.fireAndForgetProcesses[index];
  let next: FireAndForgetProcessCheckpoint;

  if (event.kind === "register") {
    requireActive(state);
    const expectedGeneration = current === undefined ? 1 : current.generation + 1;
    if (event.generation !== expectedGeneration) {
      throw new StateTransitionError("process generations must advance one at a time");
    }
    if (current !== undefined && current.phase !== "finished") {
      throw new StateTransitionError("an active process must finish before replacement");
    }
    next = {
      generation: event.generation,
      identity: event.identity,
      lifetime: "runner",
      phase: "registered",
      registeredAt: updatedAt,
      stepId: event.stepId,
      stepIndex: event.stepIndex,
    };
  } else {
    if (current === undefined || !sameProcessEvent(current, event)) {
      throw new StateTransitionError("process events must match the active stable identity");
    }
    if (event.kind === "accept") {
      requireActive(state);
      if (current.phase === "accepted") return state;
      if (current.phase !== "registered") {
        throw new StateTransitionError("only a registered process can be accepted");
      }
      next = { ...current, acceptedAt: updatedAt, phase: "accepted" };
    } else {
      requireActive(state);
      if (current.phase === "finished") {
        const sameFinish =
          current.exitCode === event.exitCode &&
          current.outcome === event.outcome &&
          current.signal === event.signal;
        if (sameFinish) return state;
        throw new StateTransitionError("a finished process outcome is immutable");
      }
      next = {
        ...current,
        exitCode: event.exitCode,
        finishedAt: updatedAt,
        outcome: event.outcome,
        phase: "finished",
        signal: event.signal,
      };
    }
  }

  const processes = [...state.fireAndForgetProcesses];
  if (index === -1) processes.push(next);
  else processes[index] = next;
  return changed(state, updatedAt, { fireAndForgetProcesses: processes });
};

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

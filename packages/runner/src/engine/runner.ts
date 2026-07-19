import type { RunnerPlan } from "@agent-boot/protocol";

import {
  identifyRunnerPlan,
  type RunnerCheckpoint,
  type RunnerDiagnostic,
  type StepCheckpoint,
} from "../state/index.js";
import { AutomaticStepExecutor } from "../steps/automatic/index.js";
import { RunnerEnvironment } from "../steps/environment/index.js";
import { loadRunnerPlan, validateAutomaticPolicy } from "./configuration.js";
import type {
  RunnerEngineOptions,
  RunnerExecutionResult,
  RunnerProgress,
} from "./model.js";
import {
  findRecoveryConflict,
  findUnsupportedStep,
  nextPendingStep,
} from "./sequencing.js";

const terminalResult = (state: RunnerCheckpoint): RunnerExecutionResult | undefined => {
  if (state.terminal === null) return undefined;
  return { state, status: state.terminal.status };
};

const attemptDiagnostic = (
  checkpoint: StepCheckpoint,
  failure: { readonly exitCode: number | null; readonly signal: NodeJS.Signals | null },
  recovery: RunnerDiagnostic["recovery"],
): RunnerDiagnostic => ({
  attempt: checkpoint.attempt,
  code: "step-attempt-failed",
  exitCode: failure.exitCode,
  recovery,
  signal: failure.signal,
  stepId: checkpoint.id,
});

export class RunnerEngine {
  readonly #automatic: AutomaticStepExecutor;
  readonly #environment: RunnerEnvironment;
  readonly #identity;
  readonly #maxAttempts: number;
  readonly #onProgress: ((progress: RunnerProgress) => void) | undefined;
  readonly #plan: RunnerPlan;
  readonly #stateStore: RunnerEngineOptions["stateStore"];

  constructor(options: RunnerEngineOptions) {
    validateAutomaticPolicy(options.automaticPolicy);
    this.#plan = loadRunnerPlan(options.serializedPlan);
    this.#identity = identifyRunnerPlan(this.#plan, options.serializedPlan);
    this.#environment = new RunnerEnvironment(options.environment);
    this.#automatic = new AutomaticStepExecutor(
      options.commandHost,
      this.#environment,
      options.automaticPolicy,
    );
    this.#maxAttempts = options.automaticPolicy.maxAttempts;
    this.#onProgress = options.onProgress;
    this.#stateStore = options.stateStore;
  }

  async run(): Promise<RunnerExecutionResult> {
    let state = await this.#stateStore.initialize(this.#identity);
    const existing = terminalResult(state);
    if (existing !== undefined) return existing;

    const conflict = findRecoveryConflict(state, this.#plan.steps);
    if (conflict !== undefined) {
      state = await this.#stateStore.markFailed(this.#identity, conflict);
      this.#emit({ diagnostic: conflict, status: "runner-failed" });
      return { state, status: "failed" };
    }

    const unsupported = findUnsupportedStep(this.#plan.steps);
    if (unsupported !== undefined) {
      const diagnostic: RunnerDiagnostic = {
        code: "manual-intervention-required",
        recovery: "manual-intervention",
        stepId: unsupported.id,
      };
      state = await this.#stateStore.markFailed(this.#identity, diagnostic);
      this.#emit({ diagnostic, status: "runner-failed" });
      return { state, status: "failed" };
    }

    for (;;) {
      const pending = nextPendingStep(state, this.#plan.steps.length, this.#maxAttempts);
      if (pending === "complete") {
        state = await this.#stateStore.markSucceeded(this.#identity);
        this.#emit({ status: "runner-succeeded" });
        return { state, status: "succeeded" };
      }
      if (pending === "exhausted") {
        const current = state.currentStep;
        if (current === null) throw new Error("Invariant violation: missing exhausted step");
        const diagnostic = attemptDiagnostic(
          current,
          { exitCode: null, signal: null },
          "manual-intervention",
        );
        state = await this.#stateStore.markFailed(this.#identity, diagnostic);
        this.#emit({ diagnostic, status: "runner-failed" });
        return { state, status: "failed" };
      }

      const step = this.#plan.steps[pending.index];
      if (step === undefined) throw new Error("Invariant violation: missing runner step");
      let checkpoint: StepCheckpoint = {
        attempt: pending.attempt,
        id: step.id,
        index: pending.index,
        phase: "started",
      };
      if (pending.shouldCheckpointStart) {
        state = await this.#stateStore.checkpointStep(this.#identity, checkpoint);
      }
      this.#emit({
        attempt: checkpoint.attempt,
        index: checkpoint.index,
        status: "step-started",
        stepId: checkpoint.id,
      });

      if (step.kind === "environment") {
        checkpoint = { ...checkpoint, phase: "succeeded" };
        state = await this.#stateStore.checkpointStep(this.#identity, checkpoint);
        this.#emitStepSucceeded(checkpoint);
        continue;
      }
      if (step.kind !== "automatic") {
        throw new Error("Invariant violation: unsupported step passed preflight");
      }

      const environment = this.#environment.forStep(this.#plan.steps, pending.index);
      const attempt = await this.#automatic.execute(step, environment);
      checkpoint = { ...checkpoint, phase: attempt.status };
      state = await this.#stateStore.checkpointStep(this.#identity, checkpoint);
      if (attempt.status === "succeeded") {
        this.#emitStepSucceeded(checkpoint);
        continue;
      }
      const finalAttempt = checkpoint.attempt === this.#maxAttempts;
      const diagnostic = attemptDiagnostic(
        checkpoint,
        attempt,
        finalAttempt ? "manual-intervention" : "retry-step",
      );
      this.#emit({
        attempt: checkpoint.attempt,
        diagnostic,
        index: checkpoint.index,
        status: "step-failed",
        stepId: checkpoint.id,
      });
      if (finalAttempt) {
        state = await this.#stateStore.markFailed(this.#identity, diagnostic);
        this.#emit({ diagnostic, status: "runner-failed" });
        return { state, status: "failed" };
      }
    }
  }

  #emit(progress: RunnerProgress): void {
    this.#onProgress?.(progress);
  }

  #emitStepSucceeded(checkpoint: StepCheckpoint): void {
    this.#emit({
      attempt: checkpoint.attempt,
      index: checkpoint.index,
      status: "step-succeeded",
      stepId: checkpoint.id,
    });
  }
}

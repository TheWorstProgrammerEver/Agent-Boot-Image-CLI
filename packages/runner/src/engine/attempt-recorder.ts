import type { RunnerPlan, RunnerStep } from "@agent-boot/protocol";

import type {
  RunnerCheckpoint,
  RunnerDiagnostic,
  RunnerPlanIdentity,
  StepCheckpoint,
} from "../state/index.js";
import type {
  RunnerCheckpointStore,
  RunnerExecutionResult,
  RunnerProgress,
} from "./model.js";
import { RunnerProcessLifecycle } from "./process-lifecycle.js";

const attemptDiagnostic = (
  checkpoint: StepCheckpoint,
  failure: { readonly exitCode: number | null; readonly signal: NodeJS.Signals | null },
  recovery: RunnerDiagnostic["recovery"],
  code: RunnerDiagnostic["code"],
): RunnerDiagnostic => ({
  attempt: checkpoint.attempt,
  code,
  exitCode: failure.exitCode,
  recovery,
  signal: failure.signal,
  stepId: checkpoint.id,
});

export class RunnerAttemptRecorder {
  readonly #automaticMaxAttempts: number;
  readonly #fireAndForgetMaxAttempts: number;
  readonly #identity: RunnerPlanIdentity;
  readonly #lifecycle: RunnerProcessLifecycle;
  readonly #onProgress: ((progress: RunnerProgress) => void) | undefined;
  readonly #plan: RunnerPlan;
  readonly #stateStore: RunnerCheckpointStore;

  constructor(options: {
    readonly automaticMaxAttempts: number;
    readonly fireAndForgetMaxAttempts: number;
    readonly identity: RunnerPlanIdentity;
    readonly lifecycle: RunnerProcessLifecycle;
    readonly onProgress?: (progress: RunnerProgress) => void;
    readonly plan: RunnerPlan;
    readonly stateStore: RunnerCheckpointStore;
  }) {
    this.#automaticMaxAttempts = options.automaticMaxAttempts;
    this.#fireAndForgetMaxAttempts = options.fireAndForgetMaxAttempts;
    this.#identity = options.identity;
    this.#lifecycle = options.lifecycle;
    this.#onProgress = options.onProgress;
    this.#plan = options.plan;
    this.#stateStore = options.stateStore;
  }

  async fail(
    state: RunnerCheckpoint,
    diagnostic: RunnerDiagnostic,
  ): Promise<RunnerExecutionResult> {
    const stopped = await this.#lifecycle.stopAll(state);
    const failure = stopped.diagnostic ?? diagnostic;
    state = await this.#stateStore.markFailed(this.#identity, failure);
    this.#emit({ diagnostic: failure, status: "runner-failed" });
    return { state, status: "failed" };
  }

  maxAttemptsForStep(step: RunnerStep | undefined): number {
    return step?.kind === "fire-and-forget"
      ? this.#fireAndForgetMaxAttempts
      : this.#automaticMaxAttempts;
  }

  async recordFailure(
    state: RunnerCheckpoint,
    checkpoint: StepCheckpoint,
    failure: { readonly exitCode: number | null; readonly signal: NodeJS.Signals | null },
    code: RunnerDiagnostic["code"] = "step-attempt-failed",
  ): Promise<{ readonly result?: RunnerExecutionResult; readonly state: RunnerCheckpoint }> {
    state = await this.#stateStore.checkpointStep(this.#identity, checkpoint);
    const finalAttempt = checkpoint.attempt >= this.maxAttemptsForStep(
      this.#plan.steps[checkpoint.index],
    );
    const diagnostic = attemptDiagnostic(
      checkpoint,
      failure,
      finalAttempt ? "manual-intervention" : "retry-step",
      code,
    );
    this.#emit({
      attempt: checkpoint.attempt,
      diagnostic,
      index: checkpoint.index,
      status: "step-failed",
      stepId: checkpoint.id,
    });
    if (!finalAttempt) return { state };
    return { result: await this.fail(state, diagnostic), state };
  }

  stepStarted(checkpoint: StepCheckpoint): void {
    this.#emit({
      attempt: checkpoint.attempt,
      index: checkpoint.index,
      status: "step-started",
      stepId: checkpoint.id,
    });
  }

  async succeed(state: RunnerCheckpoint): Promise<RunnerExecutionResult> {
    const stopped = await this.#lifecycle.stopAll(state);
    if (stopped.diagnostic !== undefined) return this.fail(stopped.state, stopped.diagnostic);
    state = await this.#stateStore.markSucceeded(this.#identity);
    this.#emit({ status: "runner-succeeded" });
    return { state, status: "succeeded" };
  }

  async succeedStep(checkpoint: StepCheckpoint): Promise<RunnerCheckpoint> {
    const succeeded = { ...checkpoint, phase: "succeeded" as const };
    const state = await this.#stateStore.checkpointStep(this.#identity, succeeded);
    this.#emit({
      attempt: succeeded.attempt,
      index: succeeded.index,
      status: "step-succeeded",
      stepId: succeeded.id,
    });
    return state;
  }

  #emit(progress: RunnerProgress): void {
    this.#onProgress?.(progress);
  }
}

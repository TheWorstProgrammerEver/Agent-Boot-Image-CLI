import type { RunnerPlan } from "@agent-boot/protocol";

import {
  identifyRunnerPlan,
  type RunnerCheckpoint,
  type RunnerDiagnostic,
  type StepCheckpoint,
} from "../state/index.js";
import type { PromptHydrator } from "../prompts/index.js";
import { ProviderStepExecutor } from "../providers/provider.js";
import { AutomaticStepExecutor } from "../steps/automatic/index.js";
import { RunnerEnvironment } from "../steps/environment/index.js";
import {
  ManualStepExecutor,
  type ManualStepProgress,
} from "../steps/manual/index.js";
import {
  loadRunnerPlan,
  validateAutomaticPolicy,
  validateManualPolicy,
  validateProviderPolicy,
} from "./configuration.js";
import { RunnerConfigurationError } from "./errors.js";
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
  failure: {
    readonly code?: RunnerDiagnostic["code"];
    readonly exitCode: number | null;
    readonly signal: NodeJS.Signals | null;
  },
  recovery: RunnerDiagnostic["recovery"],
): RunnerDiagnostic => ({
  attempt: checkpoint.attempt,
  code: failure.code ?? "step-attempt-failed",
  exitCode: failure.exitCode,
  recovery,
  signal: failure.signal,
  stepId: checkpoint.id,
});

export class RunnerEngine {
  readonly #automatic: AutomaticStepExecutor;
  readonly #environment: RunnerEnvironment;
  readonly #identity;
  readonly #manual: ManualStepExecutor;
  readonly #maxAttempts: number;
  readonly #onProgress: ((progress: RunnerProgress) => void) | undefined;
  readonly #plan: RunnerPlan;
  readonly #promptHydrator: PromptHydrator | undefined;
  readonly #provider: ProviderStepExecutor | undefined;
  readonly #stateStore: RunnerEngineOptions["stateStore"];

  constructor(options: RunnerEngineOptions) {
    validateAutomaticPolicy(options.automaticPolicy);
    validateManualPolicy(options.manualPolicy);
    const providerConfiguration = [options.providerAdapter, options.providerPolicy];
    if (
      providerConfiguration.some((value) => value !== undefined) &&
      (options.promptHydrator === undefined || providerConfiguration.some((value) => value === undefined))
    ) {
      throw new RunnerConfigurationError(
        "provider execution",
        "promptHydrator, providerAdapter, and providerPolicy must be supplied together",
      );
    }
    if (options.providerPolicy !== undefined) validateProviderPolicy(options.providerPolicy);
    this.#plan = loadRunnerPlan(options.serializedPlan);
    this.#identity = identifyRunnerPlan(this.#plan, options.serializedPlan);
    this.#environment = new RunnerEnvironment(options.environment);
    this.#automatic = new AutomaticStepExecutor(
      options.commandHost,
      this.#environment,
      options.automaticPolicy,
    );
    this.#manual = new ManualStepExecutor(
      options.commandHost,
      this.#environment,
      options.manualPolicy,
      options.manualScheduler,
    );
    this.#promptHydrator = options.promptHydrator;
    this.#provider =
      options.promptHydrator === undefined ||
      options.providerAdapter === undefined ||
      options.providerPolicy === undefined
        ? undefined
        : new ProviderStepExecutor(
            options.commandHost,
            this.#environment,
            options.promptHydrator,
            options.providerAdapter,
            options.providerPolicy,
          );
    this.#maxAttempts = options.automaticPolicy.maxAttempts;
    this.#onProgress = options.onProgress;
    this.#stateStore = options.stateStore;
  }

  async run(): Promise<RunnerExecutionResult> {
    try {
      return await this.#run();
    } finally {
      await this.#promptHydrator?.removeAll();
    }
  }

  async #run(): Promise<RunnerExecutionResult> {
    let state = await this.#stateStore.initialize(this.#identity);
    const existing = terminalResult(state);
    if (existing !== undefined) return existing;

    const conflict = findRecoveryConflict(state, this.#plan.steps);
    if (conflict !== undefined) {
      state = await this.#stateStore.markFailed(this.#identity, conflict);
      this.#emit({ diagnostic: conflict, status: "runner-failed" });
      return { state, status: "failed" };
    }

    const unsupported = findUnsupportedStep(this.#plan.steps, {
      prompt: this.#promptHydrator !== undefined,
      provider: this.#provider !== undefined,
    });
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
      if (
        !pending.shouldCheckpointStart &&
        (step.kind === "automatic" || step.kind === "provider")
      ) {
        const interrupted: StepCheckpoint = {
          attempt: pending.attempt,
          id: step.id,
          index: pending.index,
          phase: "failed",
        };
        const failure = await this.#recordAttemptFailure(
          interrupted,
          {
            ...(step.kind === "provider" ? { code: "provider-execution-failed" as const } : {}),
            exitCode: null,
            signal: null,
          },
        );
        state = failure.state;
        if (failure.result !== undefined) return failure.result;
        continue;
      }

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
      if (step.kind === "prompt") {
        if (this.#promptHydrator === undefined) {
          throw new Error("Invariant violation: prompt executor failed preflight");
        }
        const environment = this.#environment.forStep(this.#plan.steps, pending.index);
        try {
          await this.#promptHydrator.hydrate(step, environment);
        } catch {
          checkpoint = { ...checkpoint, phase: "failed" };
          const failure = await this.#recordAttemptFailure(checkpoint, {
            code: "prompt-hydration-failed",
            exitCode: null,
            signal: null,
          });
          state = failure.state;
          if (failure.result !== undefined) return failure.result;
          continue;
        }
        try {
          await this.#promptHydrator.remove(step.renderedPromptId);
        } catch {
          checkpoint = { ...checkpoint, phase: "failed" };
          const failure = await this.#recordAttemptFailure(checkpoint, {
            code: "prompt-cleanup-failed",
            exitCode: null,
            signal: null,
          });
          state = failure.state;
          if (failure.result !== undefined) return failure.result;
          continue;
        }
        checkpoint = { ...checkpoint, phase: "succeeded" };
        state = await this.#stateStore.checkpointStep(this.#identity, checkpoint);
        this.#emitStepSucceeded(checkpoint);
        continue;
      }
      if (step.kind === "manual") {
        const environment = this.#environment.forStep(this.#plan.steps, pending.index);
        const attempt = await this.#manual.execute(
          step,
          environment,
          !pending.shouldCheckpointStart,
          (progress) => {
            this.#emitManualProgress(checkpoint, progress);
          },
        );
        if (attempt.status === "succeeded") {
          checkpoint = { ...checkpoint, phase: "succeeded" };
          state = await this.#stateStore.checkpointStep(this.#identity, checkpoint);
          this.#emitStepSucceeded(checkpoint);
          continue;
        }
        checkpoint = { ...checkpoint, phase: "failed" };
        state = await this.#stateStore.checkpointStep(this.#identity, checkpoint);
        const diagnostic: RunnerDiagnostic = {
          attempt: checkpoint.attempt,
          code: attempt.code,
          exitCode: attempt.exitCode,
          recovery: "manual-intervention",
          signal: attempt.signal,
          stepId: checkpoint.id,
        };
        this.#emit({
          diagnostic,
          index: checkpoint.index,
          status: "manual-terminal-failure",
          stepId: checkpoint.id,
        });
        state = await this.#stateStore.markFailed(this.#identity, diagnostic);
        this.#emit({ diagnostic, status: "runner-failed" });
        return { state, status: "failed" };
      }
      if (step.kind === "provider") {
        const descriptor = this.#plan.providers.find(
          (provider) => provider.id === step.providerId,
        );
        const promptStepIndex = this.#plan.steps.findIndex(
          (candidate) =>
            candidate.kind === "prompt" &&
            candidate.renderedPromptId === step.renderedPromptId,
        );
        const promptStep = this.#plan.steps[promptStepIndex];
        if (
          descriptor === undefined ||
          promptStepIndex < 0 ||
          promptStep?.kind !== "prompt" ||
          this.#provider === undefined
        ) {
          throw new Error("Invariant violation: provider references failed preflight");
        }
        const attempt = await this.#provider.execute(
          step,
          descriptor,
          promptStep,
          {
            promptEnvironment: this.#environment.forStep(
              this.#plan.steps,
              promptStepIndex,
            ),
            providerEnvironment: this.#environment.forStep(
              this.#plan.steps,
              pending.index,
            ),
          },
        );
        if (attempt.status === "succeeded") {
          checkpoint = { ...checkpoint, phase: "succeeded" };
          state = await this.#stateStore.checkpointStep(this.#identity, checkpoint);
          this.#emitStepSucceeded(checkpoint);
          continue;
        }
        checkpoint = { ...checkpoint, phase: "failed" };
        const failure = await this.#recordAttemptFailure(checkpoint, attempt);
        state = failure.state;
        if (failure.result !== undefined) return failure.result;
        continue;
      }
      if (step.kind !== "automatic") {
        throw new Error("Invariant violation: unsupported step passed preflight");
      }

      const environment = this.#environment.forStep(this.#plan.steps, pending.index);
      const attempt = await this.#automatic.execute(step, environment);
      if (attempt.status === "succeeded") {
        checkpoint = { ...checkpoint, phase: "succeeded" };
        state = await this.#stateStore.checkpointStep(this.#identity, checkpoint);
        this.#emitStepSucceeded(checkpoint);
        continue;
      }
      checkpoint = { ...checkpoint, phase: "failed" };
      const failure = await this.#recordAttemptFailure(checkpoint, attempt);
      state = failure.state;
      if (failure.result !== undefined) return failure.result;
    }
  }

  async #recordAttemptFailure(
    checkpoint: StepCheckpoint,
    failure: {
      readonly code?: RunnerDiagnostic["code"];
      readonly exitCode: number | null;
      readonly signal: NodeJS.Signals | null;
    },
  ): Promise<{
    readonly result?: RunnerExecutionResult;
    readonly state: RunnerCheckpoint;
  }> {
    let state = await this.#stateStore.checkpointStep(this.#identity, checkpoint);
    const finalAttempt = checkpoint.attempt >= this.#maxAttempts;
    const diagnostic = attemptDiagnostic(
      checkpoint,
      failure,
      finalAttempt ? "manual-intervention" : "retry-step",
    );
    this.#emit({
      attempt: checkpoint.attempt,
      diagnostic,
      index: checkpoint.index,
      status: "step-failed",
      stepId: checkpoint.id,
    });
    if (!finalAttempt) return { state };

    state = await this.#stateStore.markFailed(this.#identity, diagnostic);
    this.#emit({ diagnostic, status: "runner-failed" });
    return { result: { state, status: "failed" }, state };
  }

  #emit(progress: RunnerProgress): void {
    this.#onProgress?.(progress);
  }

  #emitManualProgress(
    checkpoint: StepCheckpoint,
    progress: ManualStepProgress,
  ): void {
    if (progress.status === "waiting") {
      this.#emit({
        index: checkpoint.index,
        resumed: progress.resumed,
        status: "manual-waiting",
        stepId: checkpoint.id,
      });
      return;
    }
    if (progress.status === "retry") {
      this.#emit({
        check: progress.check,
        delayMs: progress.delayMs,
        index: checkpoint.index,
        status: "manual-check-retry",
        stepId: checkpoint.id,
      });
      return;
    }
    this.#emit({
      check: progress.check,
      index: checkpoint.index,
      status: "manual-completed",
      stepId: checkpoint.id,
    });
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

import type { FireAndForgetStep, RunnerPlan } from "@agent-boot/protocol";
import { constants as osConstants } from "node:os";

import type { PromptHydrator } from "../prompts/index.js";
import { ProviderStepExecutor } from "../providers/provider.js";
import {
  identifyRunnerPlan,
  type RunnerCheckpoint,
  type RunnerDiagnostic,
  type StepCheckpoint,
} from "../state/index.js";
import { AutomaticStepExecutor } from "../steps/automatic/index.js";
import { RunnerEnvironment } from "../steps/environment/index.js";
import {
  ManualStepExecutor,
  type ManualStepProgress,
} from "../steps/manual/index.js";
import { RunnerAttemptRecorder } from "./attempt-recorder.js";
import {
  loadRunnerPlan,
  validateAutomaticPolicy,
  validateFireAndForgetPolicy,
  validateManualPolicy,
  validateProviderPolicy,
} from "./configuration.js";
import {
  RunnerConfigurationError,
  RunnerInterruptedError,
} from "./errors.js";
import type {
  RunnerEngineOptions,
  RunnerExecutionResult,
  RunnerProgress,
} from "./model.js";
import { RunnerProcessLifecycle } from "./process-lifecycle.js";
import {
  findRecoveryConflict,
  findUnsupportedStep,
  nextPendingStep,
} from "./sequencing.js";

const terminalResult = (state: RunnerCheckpoint): RunnerExecutionResult | undefined => {
  if (state.terminal === null) return undefined;
  return { state, status: state.terminal.status };
};

const processResult = (diagnostic: RunnerDiagnostic) => ({
  exitCode: diagnostic.exitCode ?? null,
  signal: diagnostic.signal ?? null,
});

const interruptionSignal = (signal: AbortSignal | undefined): NodeJS.Signals => {
  const reason = signal?.reason as unknown;
  return typeof reason === "string" &&
    reason !== "SIGKILL" &&
    reason !== "SIGSTOP" &&
    reason in osConstants.signals
    ? reason as NodeJS.Signals
    : "SIGTERM";
};

export class RunnerEngine {
  readonly #automatic: AutomaticStepExecutor;
  readonly #attempts: RunnerAttemptRecorder;
  readonly #cancellation: AbortSignal | undefined;
  readonly #environment: RunnerEnvironment;
  readonly #identity;
  readonly #manual: ManualStepExecutor;
  readonly #onProgress: ((progress: RunnerProgress) => void) | undefined;
  readonly #plan: RunnerPlan;
  readonly #processLifecycle: RunnerProcessLifecycle;
  readonly #promptHydrator: PromptHydrator | undefined;
  readonly #provider: ProviderStepExecutor | undefined;
  readonly #stateStore: RunnerEngineOptions["stateStore"];

  constructor(options: RunnerEngineOptions) {
    validateAutomaticPolicy(options.automaticPolicy);
    validateFireAndForgetPolicy(options.fireAndForgetPolicy);
    validateManualPolicy(options.manualPolicy);
    const providerConfiguration = [options.providerAdapter, options.providerPolicy];
    if (
      providerConfiguration.some((value) => value !== undefined) &&
      (
        options.promptHydrator === undefined ||
        providerConfiguration.some((value) => value === undefined)
      )
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
    this.#cancellation = options.cancellation;
    this.#onProgress = options.onProgress;
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
    this.#stateStore = options.stateStore;
    this.#processLifecycle = new RunnerProcessLifecycle(
      options,
      this.#plan,
      this.#identity,
      this.#environment,
    );
    this.#attempts = new RunnerAttemptRecorder({
      automaticMaxAttempts: options.automaticPolicy.maxAttempts,
      fireAndForgetMaxAttempts: options.fireAndForgetPolicy.maxLaunchAttempts,
      identity: this.#identity,
      lifecycle: this.#processLifecycle,
      ...(options.onProgress === undefined ? {} : { onProgress: options.onProgress }),
      plan: this.#plan,
      stateStore: this.#stateStore,
    });
  }

  async run(): Promise<RunnerExecutionResult> {
    try {
      return await this.#run();
    } finally {
      await this.#promptHydrator?.removeAll();
    }
  }

  async #run(): Promise<RunnerExecutionResult> {
    let state: RunnerCheckpoint | undefined;
    try {
      state = await this.#stateStore.initialize(this.#identity);
      const existing = terminalResult(state);
      if (existing !== undefined) return existing;

      const conflict = findRecoveryConflict(state, this.#plan.steps);
      if (conflict !== undefined) return await this.#attempts.fail(state, conflict);

      const unsupported = findUnsupportedStep(this.#plan.steps, {
        prompt: this.#promptHydrator !== undefined,
        provider: this.#provider !== undefined,
      });
      if (unsupported !== undefined) {
        return await this.#attempts.fail(state, {
          code: "manual-intervention-required",
          recovery: "manual-intervention",
          stepId: unsupported.id,
        });
      }

      const reconciliation = await this.#processLifecycle.reconcileCompleted(state);
      state = reconciliation.state;
      if (reconciliation.diagnostic !== undefined) {
        return await this.#attempts.fail(state, reconciliation.diagnostic);
      }

      for (;;) {
        this.#throwIfCanceled();
        const health = await this.#processLifecycle.checkHealth(state);
        state = health.state;
        if (health.diagnostic !== undefined) {
          return await this.#attempts.fail(state, health.diagnostic);
        }

        const pending = nextPendingStep(
          state,
          this.#plan.steps.length,
          this.#attempts.maxAttemptsForStep(this.#plan.steps[state.currentStep?.index ?? 0]),
        );
        if (pending === "complete") return await this.#attempts.succeed(state);
        if (pending === "exhausted") {
          const current = state.currentStep;
          if (current === null) throw new Error("Invariant violation: missing exhausted step");
          return await this.#attempts.fail(
            state,
            {
              attempt: current.attempt,
              code: "step-attempt-failed",
              exitCode: null,
              recovery: "manual-intervention",
              signal: null,
              stepId: current.id,
            },
          );
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
          const failure = await this.#attempts.recordFailure(
            state,
            interrupted,
            { exitCode: null, signal: null },
            step.kind === "provider" ? "provider-execution-failed" : "step-attempt-failed",
          );
          state = failure.state;
          if (failure.result !== undefined) return failure.result;
          continue;
        }
        if (!pending.shouldCheckpointStart && step.kind === "fire-and-forget") {
          const resumed = await this.#resumeStartedFireAndForget(state, step);
          state = resumed.state;
          if (resumed.result !== undefined) return resumed.result;
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
        this.#attempts.stepStarted(checkpoint);

        if (step.kind === "environment") {
          state = await this.#attempts.succeedStep(checkpoint);
          continue;
        }

        const environment = this.#environment.forStep(this.#plan.steps, pending.index);
        if (step.kind === "prompt") {
          if (this.#promptHydrator === undefined) {
            throw new Error("Invariant violation: prompt executor failed preflight");
          }
          try {
            await this.#promptHydrator.hydrate(step, environment);
          } catch {
            checkpoint = { ...checkpoint, phase: "failed" };
            const failure = await this.#attempts.recordFailure(
              state,
              checkpoint,
              { exitCode: null, signal: null },
              "prompt-hydration-failed",
            );
            state = failure.state;
            if (failure.result !== undefined) return failure.result;
            continue;
          }
          try {
            await this.#promptHydrator.remove(step.renderedPromptId);
          } catch {
            checkpoint = { ...checkpoint, phase: "failed" };
            const failure = await this.#attempts.recordFailure(
              state,
              checkpoint,
              { exitCode: null, signal: null },
              "prompt-cleanup-failed",
            );
            state = failure.state;
            if (failure.result !== undefined) return failure.result;
            continue;
          }
          state = await this.#attempts.succeedStep(checkpoint);
          continue;
        }
        if (step.kind === "manual") {
          const attempt = await this.#manual.execute(
            step,
            environment,
            !pending.shouldCheckpointStart,
            (progress) => {
              this.#emitManualProgress(checkpoint, progress);
            },
          );
          this.#throwIfCanceled();
          if (attempt.status === "succeeded") {
            state = await this.#attempts.succeedStep(checkpoint);
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
          return await this.#attempts.fail(state, diagnostic);
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
              providerEnvironment: environment,
            },
          );
          this.#throwIfCanceled();
          if (attempt.status === "succeeded") {
            state = await this.#attempts.succeedStep(checkpoint);
            continue;
          }
          checkpoint = { ...checkpoint, phase: "failed" };
          const failure = await this.#attempts.recordFailure(
            state,
            checkpoint,
            attempt,
            attempt.code,
          );
          state = failure.state;
          if (failure.result !== undefined) return failure.result;
          continue;
        }
        if (step.kind === "automatic") {
          const attempt = await this.#automatic.execute(step, environment, this.#cancellation);
          this.#throwIfCanceled();
          if (attempt.status === "succeeded") {
            state = await this.#attempts.succeedStep(checkpoint);
            continue;
          }
          checkpoint = { ...checkpoint, phase: "failed" };
          const failure = await this.#attempts.recordFailure(state, checkpoint, attempt);
          state = failure.state;
          if (failure.result !== undefined) return failure.result;
          continue;
        }
        if (step.kind !== "fire-and-forget") {
          throw new Error("Invariant violation: unsupported step passed preflight");
        }

        const launch = await this.#processLifecycle.launch(state, step, pending.index);
        this.#throwIfCanceled();
        state = launch.state;
        if (launch.status === "accepted") {
          state = await this.#attempts.succeedStep(checkpoint);
          continue;
        }
        checkpoint = { ...checkpoint, phase: "failed" };
        const failure = await this.#attempts.recordFailure(
          state,
          checkpoint,
          processResult(launch.diagnostic),
          launch.diagnostic.code,
        );
        state = failure.state;
        if (failure.result !== undefined) return failure.result;
      }
    } catch (error) {
      if (state !== undefined && state.terminal === null) {
        state = (
          await this.#processLifecycle.stopAll(
            state,
            interruptionSignal(this.#cancellation),
          )
        ).state;
      }
      if (
        this.#cancellation?.aborted === true &&
        !(error instanceof RunnerInterruptedError)
      ) {
        throw new RunnerInterruptedError();
      }
      throw error;
    }
  }

  async #resumeStartedFireAndForget(
    state: RunnerCheckpoint,
    step: FireAndForgetStep,
  ): Promise<{ readonly result?: RunnerExecutionResult; readonly state: RunnerCheckpoint }> {
    const current = state.currentStep;
    if (current === null) throw new Error("Invariant violation: missing started step");
    const resumed = await this.#processLifecycle.resumeStarted(state, step);
    state = resumed.state;
    if (resumed.status === "accepted") {
      return { state: await this.#attempts.succeedStep(current) };
    }
    if (resumed.status === "failed") {
      return this.#attempts.recordFailure(
        state,
        { ...current, phase: "failed" },
        processResult(resumed.diagnostic),
        resumed.diagnostic.code,
      );
    }
    return this.#attempts.recordFailure(
      state,
      { ...current, phase: "failed" },
      { exitCode: null, signal: null },
      "fire-and-forget-launch-failed",
    );
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

  #throwIfCanceled(): void {
    if (this.#cancellation?.aborted === true) throw new RunnerInterruptedError();
  }
}

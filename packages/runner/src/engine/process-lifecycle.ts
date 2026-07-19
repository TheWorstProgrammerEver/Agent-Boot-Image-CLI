import type { FireAndForgetStep, RunnerPlan } from "@agent-boot/protocol";

import type {
  RunnerCheckpoint,
  RunnerDiagnostic,
  RunnerPlanIdentity,
} from "../state/index.js";
import { RunnerEnvironment } from "../steps/environment/index.js";
import {
  FireAndForgetSupervisor,
  LinuxProcessIdentityHost,
  type FireAndForgetLaunchResult,
} from "../steps/fire-and-forget/index.js";
import type { RunnerEngineOptions } from "./model.js";

export class RunnerProcessLifecycle {
  readonly #environment: RunnerEnvironment;
  readonly #plan: RunnerPlan;
  readonly #supervisor: FireAndForgetSupervisor;

  constructor(
    options: RunnerEngineOptions,
    plan: RunnerPlan,
    identity: RunnerPlanIdentity,
    environment: RunnerEnvironment,
  ) {
    this.#environment = environment;
    this.#plan = plan;
    this.#supervisor = new FireAndForgetSupervisor({
      commandHost: options.commandHost,
      identityHost: options.processIdentityHost ?? new LinuxProcessIdentityHost(),
      plan: identity,
      policy: options.fireAndForgetPolicy,
      stateStore: options.stateStore,
      ...(options.lifecycleWait === undefined ? {} : { wait: options.lifecycleWait }),
    });
  }

  checkHealth(state: RunnerCheckpoint): Promise<{
    readonly diagnostic?: RunnerDiagnostic;
    readonly state: RunnerCheckpoint;
  }> {
    return this.#supervisor.checkHealth(state);
  }

  launch(
    state: RunnerCheckpoint,
    step: FireAndForgetStep,
    stepIndex: number,
  ): Promise<FireAndForgetLaunchResult> {
    return this.#supervisor.launch(
      state,
      step,
      stepIndex,
      this.#environment.forStep(this.#plan.steps, stepIndex),
      this.#environment,
    );
  }

  async reconcileCompleted(state: RunnerCheckpoint): Promise<{
    readonly diagnostic?: RunnerDiagnostic;
    readonly state: RunnerCheckpoint;
  }> {
    const current = state.currentStep;
    if (current === null) return { state };
    for (let index = 0; index <= current.index; index += 1) {
      const completed = index < current.index || current.phase === "succeeded";
      const step = this.#plan.steps[index];
      if (!completed || step?.kind !== "fire-and-forget") continue;
      const process = state.fireAndForgetProcesses.find((entry) => entry.stepId === step.id);
      if (process === undefined) {
        return {
          diagnostic: this.#diagnostic("fire-and-forget-reconciliation-failed", step.id),
          state,
        };
      }

      if (process.phase !== "finished") {
        const sameBoot = await this.#supervisor.isCurrentBoot(process);
        const resumed = await this.#supervisor.resume(state, process);
        state = resumed.state;
        if (resumed.status === "accepted") continue;
        if (sameBoot) {
          return {
            diagnostic: this.#diagnostic("fire-and-forget-process-exited", step.id),
            state,
          };
        }
      } else if (
        process.outcome !== "runner-shutdown" &&
        await this.#supervisor.isCurrentBoot(process)
      ) {
        return {
          diagnostic: this.#diagnostic("fire-and-forget-process-exited", step.id),
          state,
        };
      }

      const launch = await this.launch(state, step, index);
      state = launch.state;
      if (launch.status === "failed") {
        return {
          diagnostic: {
            ...launch.diagnostic,
            code: "fire-and-forget-reconciliation-failed",
            recovery: "manual-intervention",
          },
          state,
        };
      }
    }
    return { state };
  }

  async resumeStarted(
    state: RunnerCheckpoint,
    step: FireAndForgetStep,
  ): Promise<FireAndForgetLaunchResult | { readonly state: RunnerCheckpoint; readonly status: "missing" }> {
    const process = state.fireAndForgetProcesses.find((entry) => entry.stepId === step.id);
    if (process === undefined) return { state, status: "missing" };
    const sameBoot = await this.#supervisor.isCurrentBoot(process);
    if (process.phase === "finished") {
      return process.outcome === "runner-shutdown" || !sameBoot
        ? this.launch(state, step, process.stepIndex)
        : {
            diagnostic: this.#diagnostic(
              process.acceptedAt === undefined
                ? "fire-and-forget-early-exit"
                : "fire-and-forget-process-exited",
              step.id,
            ),
            state,
            status: "failed",
          };
    }
    const resumed = await this.#supervisor.resume(state, process);
    if (resumed.status !== "missing") return resumed;
    return sameBoot
      ? {
          diagnostic: this.#diagnostic(
            process.acceptedAt === undefined
              ? "fire-and-forget-early-exit"
              : "fire-and-forget-process-exited",
            step.id,
          ),
          state: resumed.state,
          status: "failed",
        }
      : this.launch(resumed.state, step, process.stepIndex);
  }

  async stopAll(
    state: RunnerCheckpoint,
    signal: NodeJS.Signals = "SIGTERM",
  ): Promise<{ readonly diagnostic?: RunnerDiagnostic; readonly state: RunnerCheckpoint }> {
    let diagnostic: RunnerDiagnostic | undefined;
    for (const process of state.fireAndForgetProcesses) {
      if (process.phase === "finished" || this.#supervisor.isTracking(process.stepId)) continue;
      const resumed = await this.#supervisor.resume(state, process);
      state = resumed.state;
      if (resumed.status === "failed") diagnostic ??= resumed.diagnostic;
    }
    const stopped = await this.#supervisor.shutdown(state, signal);
    const finalDiagnostic = stopped.diagnostic ?? diagnostic;
    return {
      ...(finalDiagnostic === undefined ? {} : { diagnostic: finalDiagnostic }),
      state: stopped.state,
    };
  }

  #diagnostic(code: RunnerDiagnostic["code"], stepId: string): RunnerDiagnostic {
    return { code, recovery: "manual-intervention", stepId };
  }
}

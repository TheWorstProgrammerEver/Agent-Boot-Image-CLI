import { setTimeout as wait } from "node:timers/promises";

import type { RunningCommand, SpawnResult } from "@agent-boot/process";
import type { FireAndForgetStep } from "@agent-boot/protocol";

import type { ChildEnvironment, RunnerEnvironment } from "../environment/index.js";
import type {
  FireAndForgetProcessCheckpoint,
  FireAndForgetProcessOutcome,
  RunnerCheckpoint,
  RunnerDiagnostic,
} from "../../state/index.js";
import type { FireAndForgetSupervisorOptions, TrackedProcessResult } from "./model.js";

interface TrackedProcess {
  checkpoint: FireAndForgetProcessCheckpoint;
  readonly running?: RunningCommand;
  result?: TrackedProcessResult;
}

export type FireAndForgetLaunchResult =
  | { readonly state: RunnerCheckpoint; readonly status: "accepted" }
  | {
      readonly diagnostic: RunnerDiagnostic;
      readonly state: RunnerCheckpoint;
      readonly status: "failed";
    };

const failedResult: SpawnResult = {
  exitCode: null,
  reason: "exit",
  signal: null,
};

const acceptanceInterrupted = (): Error =>
  new Error("Runner cancellation interrupted fire-and-forget acceptance");

const exitDiagnostic = (
  process: FireAndForgetProcessCheckpoint,
  result: SpawnResult,
  code: RunnerDiagnostic["code"],
): RunnerDiagnostic => ({
  code,
  exitCode: result.exitCode,
  recovery: "manual-intervention",
  signal: result.signal,
  stepId: process.stepId,
});

export class FireAndForgetSupervisor {
  readonly #commandHost: FireAndForgetSupervisorOptions["commandHost"];
  readonly #identityHost: FireAndForgetSupervisorOptions["identityHost"];
  readonly #instances = new Map<string, TrackedProcess>();
  readonly #plan: FireAndForgetSupervisorOptions["plan"];
  readonly #policy: FireAndForgetSupervisorOptions["policy"];
  readonly #stateStore: FireAndForgetSupervisorOptions["stateStore"];
  readonly #wait: (milliseconds: number, cancellation: AbortSignal) => Promise<void>;

  constructor(options: FireAndForgetSupervisorOptions) {
    this.#commandHost = options.commandHost;
    this.#identityHost = options.identityHost;
    this.#plan = options.plan;
    this.#policy = options.policy;
    this.#stateStore = options.stateStore;
    this.#wait = options.wait ?? ((milliseconds, cancellation) =>
      wait(milliseconds, undefined, { signal: cancellation }));
  }

  isTracking(stepId: string): boolean {
    return this.#instances.has(stepId);
  }

  async isCurrentBoot(process: FireAndForgetProcessCheckpoint): Promise<boolean> {
    return process.identity.bootId === await this.#identityHost.currentBootId();
  }

  async launch(
    state: RunnerCheckpoint,
    step: FireAndForgetStep,
    stepIndex: number,
    environment: ChildEnvironment,
    runnerEnvironment: RunnerEnvironment,
    cancellation?: AbortSignal,
  ): Promise<FireAndForgetLaunchResult> {
    const prior = state.fireAndForgetProcesses.find((process) => process.stepId === step.id);
    const generation = (prior?.generation ?? 0) + 1;
    let running: RunningCommand;
    try {
      running = this.#commandHost.spawn({
        arguments: step.command.arguments,
        cwd: runnerEnvironment.workingDirectoryFor(step.command),
        environment,
        executable: step.command.executable,
        label: `runner step ${step.id}`,
        lifetime: { policy: "managed" },
        stdio: "inherit",
      });
    } catch {
      return {
        diagnostic: {
          code: "fire-and-forget-launch-failed",
          recovery: "manual-intervention",
          stepId: step.id,
        },
        state,
        status: "failed",
      };
    }

    const completion = running.completion.then(
      result => ({ error: false, result } satisfies TrackedProcessResult),
      () => ({ error: true, result: failedResult } satisfies TrackedProcessResult),
    );

    const pid = running.pid;
    let identity;
    try {
      identity = pid === undefined ? undefined : await this.#identityHost.capture(pid);
    } catch {
      running.cancel();
      await completion;
      return {
        diagnostic: {
          code: "fire-and-forget-launch-failed",
          recovery: "manual-intervention",
          stepId: step.id,
        },
        state,
        status: "failed",
      };
    }
    if (identity === undefined || identity.processGroupId !== identity.pid) {
      running.cancel();
      await running.completion.catch(() => undefined);
      return {
        diagnostic: {
          code: "fire-and-forget-launch-failed",
          recovery: "manual-intervention",
          stepId: step.id,
        },
        state,
        status: "failed",
      };
    }

    try {
      state = await this.#stateStore.checkpointFireAndForgetProcess(this.#plan, {
        generation,
        identity,
        kind: "register",
        stepId: step.id,
        stepIndex,
      });
    } catch (error) {
      running.cancel();
      await completion;
      throw error;
    }
    const checkpoint = this.#processFor(state, step.id);
    const tracked: TrackedProcess = { checkpoint, running };
    void completion.then(result => {
      tracked.result = result;
    });
    this.#instances.set(step.id, tracked);

    const accepted = await this.#survivesAcceptanceWindow(tracked, cancellation);
    if (!accepted) {
      const result = tracked.result?.result ?? failedResult;
      state = await this.#finish(state, tracked, "exited-before-acceptance", result);
      this.#instances.delete(step.id);
      return {
        diagnostic: exitDiagnostic(
          checkpoint,
          result,
          "fire-and-forget-early-exit",
        ),
        state,
        status: "failed",
      };
    }

    state = await this.#stateStore.checkpointFireAndForgetProcess(this.#plan, {
      generation,
      identity,
      kind: "accept",
      stepId: step.id,
      stepIndex,
    });
    tracked.checkpoint = this.#processFor(state, step.id);
    return { state, status: "accepted" };
  }

  async resume(
    state: RunnerCheckpoint,
    process: FireAndForgetProcessCheckpoint,
    cancellation?: AbortSignal,
  ): Promise<FireAndForgetLaunchResult | { readonly state: RunnerCheckpoint; readonly status: "missing" }> {
    if (!(await this.#identityHost.matches(process.identity))) {
      state = await this.#finish(state, { checkpoint: process }, "reconciled-missing", failedResult);
      return { state, status: "missing" };
    }
    const tracked: TrackedProcess = { checkpoint: process };
    this.#instances.set(process.stepId, tracked);
    if (process.phase === "accepted") return { state, status: "accepted" };
    if (process.phase !== "registered") return { state, status: "missing" };

    if (!(await this.#survivesAcceptanceWindow(tracked, cancellation))) {
      state = await this.#finish(state, tracked, "exited-before-acceptance", failedResult);
      this.#instances.delete(process.stepId);
      return {
        diagnostic: exitDiagnostic(
          process,
          failedResult,
          "fire-and-forget-early-exit",
        ),
        state,
        status: "failed",
      };
    }
    state = await this.#stateStore.checkpointFireAndForgetProcess(this.#plan, {
      generation: process.generation,
      identity: process.identity,
      kind: "accept",
      stepId: process.stepId,
      stepIndex: process.stepIndex,
    });
    tracked.checkpoint = this.#processFor(state, process.stepId);
    return { state, status: "accepted" };
  }

  async checkHealth(state: RunnerCheckpoint): Promise<{
    readonly diagnostic?: RunnerDiagnostic;
    readonly state: RunnerCheckpoint;
  }> {
    for (const tracked of this.#instances.values()) {
      const result = tracked.result?.result;
      const alive = result === undefined && await this.#identityHost.matches(tracked.checkpoint.identity);
      if (alive) continue;
      const failure = result ?? failedResult;
      state = await this.#finish(state, tracked, "exited-after-acceptance", failure);
      this.#instances.delete(tracked.checkpoint.stepId);
      return {
        diagnostic: exitDiagnostic(
          tracked.checkpoint,
          failure,
          "fire-and-forget-process-exited",
        ),
        state,
      };
    }
    return { state };
  }

  async shutdown(
    state: RunnerCheckpoint,
    signal: NodeJS.Signals = "SIGTERM",
  ): Promise<{ readonly diagnostic?: RunnerDiagnostic; readonly state: RunnerCheckpoint }> {
    let diagnostic: RunnerDiagnostic | undefined;
    for (const tracked of [...this.#instances.values()]) {
      const existing = tracked.result?.result;
      if (existing !== undefined) {
        state = await this.#finish(state, tracked, "exited-after-acceptance", existing);
        diagnostic ??= exitDiagnostic(
          tracked.checkpoint,
          existing,
          "fire-and-forget-process-exited",
        );
        this.#instances.delete(tracked.checkpoint.stepId);
        continue;
      }

      let stopped = true;
      let result = failedResult;
      if (tracked.running !== undefined) {
        tracked.running.cancel(signal);
        result = await tracked.running.completion.catch(() => failedResult);
      } else {
        stopped = await this.#identityHost.terminate(
          tracked.checkpoint.identity,
          signal,
          this.#policy.terminationGraceMs,
        );
      }
      if (!stopped) {
        throw new Error("Unable to stop a supervised runner-lifetime process");
      }
      state = await this.#finish(state, tracked, "runner-shutdown", result);
      this.#instances.delete(tracked.checkpoint.stepId);
    }
    return { ...(diagnostic === undefined ? {} : { diagnostic }), state };
  }

  async #finish(
    state: RunnerCheckpoint,
    tracked: TrackedProcess,
    outcome: FireAndForgetProcessOutcome,
    result: SpawnResult,
  ): Promise<RunnerCheckpoint> {
    if (tracked.checkpoint.phase === "finished") return state;
    return this.#stateStore.checkpointFireAndForgetProcess(this.#plan, {
      exitCode: result.exitCode,
      generation: tracked.checkpoint.generation,
      identity: tracked.checkpoint.identity,
      kind: "finish",
      outcome,
      signal: result.signal,
      stepId: tracked.checkpoint.stepId,
      stepIndex: tracked.checkpoint.stepIndex,
    });
  }

  #processFor(state: RunnerCheckpoint, stepId: string): FireAndForgetProcessCheckpoint {
    const process = state.fireAndForgetProcesses.find((entry) => entry.stepId === stepId);
    if (process === undefined) throw new Error("Invariant violation: missing process checkpoint");
    return process;
  }

  async #survivesAcceptanceWindow(
    tracked: TrackedProcess,
    cancellation?: AbortSignal,
  ): Promise<boolean> {
    const waitCancellation = new AbortController();
    let interrupt: (() => void) | undefined;
    const interrupted = cancellation === undefined
      ? undefined
      : new Promise<never>((_resolve, reject) => {
        interrupt = (): void => {
          reject(acceptanceInterrupted());
        };
        if (cancellation.aborted) interrupt();
        else cancellation.addEventListener("abort", interrupt, { once: true });
      });
    try {
      await Promise.race([
        this.#wait(this.#policy.acceptanceWindowMs, waitCancellation.signal),
        ...(interrupted === undefined ? [] : [interrupted]),
      ]);
    } finally {
      waitCancellation.abort();
      if (interrupt !== undefined) {
        cancellation?.removeEventListener("abort", interrupt);
      }
    }
    if (tracked.result !== undefined) return false;
    return this.#identityHost.matches(tracked.checkpoint.identity);
  }

}

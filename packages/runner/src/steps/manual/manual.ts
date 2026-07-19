import type {
  RunningCommand,
  SpawnHost,
  SpawnResult,
} from "@agent-boot/process";
import type { ManualStep } from "@agent-boot/protocol";

import type {
  ManualStepPolicy,
  ManualStepScheduler,
} from "../../engine/model.js";
import type { RunnerDiagnosticCode } from "../../state/index.js";
import { RunnerEnvironment, type ChildEnvironment } from "../environment/index.js";
import { systemManualStepScheduler } from "./scheduler.js";

type ManualFailureCode = Extract<
  RunnerDiagnosticCode,
  | "manual-command-failed"
  | "manual-completion-check-failed"
  | "manual-gate-incomplete"
>;

export interface ManualAttemptFailure {
  readonly code: ManualFailureCode;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
}

export type ManualAttemptResult =
  | { readonly status: "succeeded" }
  | ({ readonly status: "failed" } & ManualAttemptFailure);

export type ManualStepProgress =
  | { readonly check: number; readonly status: "completed" }
  | {
      readonly check: number;
      readonly delayMs: number;
      readonly status: "retry";
    }
  | { readonly resumed: boolean; readonly status: "waiting" };

type CompletionCheckResult =
  | { readonly status: "completed" }
  | { readonly status: "incomplete" }
  | { readonly status: "failed" };

type ForegroundOutcome =
  | { readonly result: SpawnResult; readonly status: "completed" }
  | { readonly status: "failed" };

type WaitOutcome =
  | { readonly status: "delay-elapsed" }
  | {
      readonly outcome: ForegroundOutcome;
      readonly status: "foreground-completed";
    };

const completed = (result: SpawnResult): boolean =>
  result.reason === "exit" && result.exitCode === 0 && result.signal === null;

const failure = (
  code: ManualFailureCode,
  result?: SpawnResult,
): ManualAttemptResult => ({
  code,
  exitCode: result?.exitCode ?? null,
  signal: result?.signal ?? null,
  status: "failed",
});

export class ManualStepExecutor {
  readonly #commandHost: SpawnHost;
  readonly #environment: RunnerEnvironment;
  readonly #policy: ManualStepPolicy;
  readonly #scheduler: ManualStepScheduler;

  constructor(
    commandHost: SpawnHost,
    environment: RunnerEnvironment,
    policy: ManualStepPolicy,
    scheduler?: ManualStepScheduler,
  ) {
    this.#commandHost = commandHost;
    this.#environment = environment;
    this.#policy = policy;
    this.#scheduler = scheduler ?? systemManualStepScheduler;
  }

  async execute(
    step: ManualStep,
    environment: ChildEnvironment,
    resumed: boolean,
    onProgress?: (progress: ManualStepProgress) => void,
  ): Promise<ManualAttemptResult> {
    let check = 1;
    const existing = await this.#checkCompletion(step, environment);
    if (existing.status === "completed") {
      onProgress?.({ check, status: "completed" });
      return { status: "succeeded" };
    }
    if (existing.status === "failed") {
      return failure("manual-completion-check-failed");
    }

    let foreground: RunningCommand;
    try {
      foreground = this.#commandHost.spawn({
        arguments: step.command.arguments,
        cwd: this.#environment.workingDirectoryFor(step.command),
        environment,
        executable: step.command.executable,
        forwardSignals: ["SIGHUP", "SIGINT", "SIGTERM"],
        label: `runner manual step ${step.id}`,
        lifetime: { policy: "managed" },
        stdio: "inherit",
      });
    } catch {
      return failure("manual-command-failed");
    }

    const foregroundOutcome: Promise<ForegroundOutcome> = foreground.completion.then(
      (result) => ({ result, status: "completed" }),
      () => ({ status: "failed" }),
    );
    onProgress?.({ resumed, status: "waiting" });
    let delayMs = Math.min(
      step.pollIntervalSeconds * 1_000,
      this.#policy.maximumPollIntervalMs,
    );
    onProgress?.({ check, delayMs, status: "retry" });

    for (;;) {
      let wait: WaitOutcome;
      try {
        wait = await this.#waitForForegroundOrDelay(foregroundOutcome, delayMs);
      } catch {
        await this.#stopForeground(foreground, foregroundOutcome);
        return failure("manual-completion-check-failed");
      }

      check += 1;
      const probe = await this.#checkCompletion(step, environment);
      if (probe.status === "completed") {
        await this.#stopForeground(foreground, foregroundOutcome);
        onProgress?.({ check, status: "completed" });
        return { status: "succeeded" };
      }
      if (probe.status === "failed") {
        await this.#stopForeground(foreground, foregroundOutcome);
        return failure("manual-completion-check-failed");
      }
      if (wait.status === "foreground-completed") {
        if (wait.outcome.status === "completed") {
          return failure(
            completed(wait.outcome.result)
              ? "manual-gate-incomplete"
              : "manual-command-failed",
            wait.outcome.result,
          );
        }
        return failure("manual-command-failed");
      }

      delayMs = Math.min(delayMs * 2, this.#policy.maximumPollIntervalMs);
      onProgress?.({ check, delayMs, status: "retry" });
    }
  }

  async #checkCompletion(
    step: ManualStep,
    environment: ChildEnvironment,
  ): Promise<CompletionCheckResult> {
    try {
      const running = this.#commandHost.spawn({
        arguments: step.completionCheck.arguments,
        cwd: this.#environment.workingDirectoryFor(step.completionCheck),
        environment,
        executable: step.completionCheck.executable,
        label: `runner manual completion check ${step.id}`,
        lifetime: { policy: "managed" },
        stdio: "stream",
        timeoutMs: this.#policy.completionCheckTimeoutMs,
      });
      return completed(await running.completion)
        ? { status: "completed" }
        : { status: "incomplete" };
    } catch {
      return { status: "failed" };
    }
  }

  async #stopForeground(
    foreground: RunningCommand,
    outcome: Promise<ForegroundOutcome>,
  ): Promise<void> {
    foreground.cancel();
    await outcome;
  }

  async #waitForForegroundOrDelay(
    foreground: Promise<ForegroundOutcome>,
    delayMs: number,
  ): Promise<WaitOutcome> {
    const controller = new AbortController();
    try {
      return await Promise.race([
        foreground.then(
          (outcome): WaitOutcome => ({ outcome, status: "foreground-completed" }),
        ),
        this.#scheduler.sleep(delayMs, controller.signal).then(
          (): WaitOutcome => ({ status: "delay-elapsed" }),
        ),
      ]);
    } finally {
      controller.abort();
    }
  }
}

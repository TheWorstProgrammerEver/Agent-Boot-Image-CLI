import type { SpawnHost, SpawnResult } from "@agent-boot/process";
import type { AutomaticStep } from "@agent-boot/protocol";

import type { AutomaticStepPolicy } from "../../engine/model.js";
import { RunnerEnvironment, type ChildEnvironment } from "../environment/index.js";

export interface AutomaticAttemptFailure {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
}

export type AutomaticAttemptResult =
  | { readonly status: "succeeded" }
  | ({ readonly status: "failed" } & AutomaticAttemptFailure);

const succeeded = (result: SpawnResult): boolean =>
  result.reason === "exit" && result.exitCode === 0 && result.signal === null;

export class AutomaticStepExecutor {
  readonly #commandHost: SpawnHost;
  readonly #environment: RunnerEnvironment;
  readonly #policy: AutomaticStepPolicy;

  constructor(
    commandHost: SpawnHost,
    environment: RunnerEnvironment,
    policy: AutomaticStepPolicy,
  ) {
    this.#commandHost = commandHost;
    this.#environment = environment;
    this.#policy = policy;
  }

  async execute(
    step: AutomaticStep,
    environment: ChildEnvironment,
    cancellation?: AbortSignal,
  ): Promise<AutomaticAttemptResult> {
    try {
      const running = this.#commandHost.spawn({
        arguments: step.command.arguments,
        ...(cancellation === undefined ? {} : { cancellation }),
        cwd: this.#environment.workingDirectoryFor(step.command),
        environment,
        executable: step.command.executable,
        label: `runner step ${step.id}`,
        lifetime: { policy: "managed" },
        stdio: "inherit",
        timeoutMs: this.#policy.timeoutMs,
      });
      const result = await running.completion;
      return succeeded(result)
        ? { status: "succeeded" }
        : { exitCode: result.exitCode, signal: result.signal, status: "failed" };
    } catch {
      return { exitCode: null, signal: null, status: "failed" };
    }
  }
}

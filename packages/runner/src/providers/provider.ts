import type { SpawnHost, SpawnResult } from "@agent-boot/process";
import type {
  PromptStep,
  ProviderDescriptor,
  ProviderStep,
} from "@agent-boot/protocol";

import type { ProviderStepPolicy } from "../engine/model.js";
import type { PromptHydrator } from "../prompts/index.js";
import { RunnerEnvironment, type ChildEnvironment } from "../steps/environment/index.js";
import type { ProviderDescriptorAdapter } from "./adapter.js";

export type ProviderFailureCode =
  | "prompt-cleanup-failed"
  | "prompt-hydration-failed"
  | "provider-execution-failed";

export type ProviderAttemptResult =
  | { readonly status: "succeeded" }
  | {
      readonly code: ProviderFailureCode;
      readonly exitCode: number | null;
      readonly signal: NodeJS.Signals | null;
      readonly status: "failed";
    };

const succeeded = (result: SpawnResult): boolean =>
  result.reason === "exit" && result.exitCode === 0 && result.signal === null;

const failed = (
  code: ProviderFailureCode,
  result?: SpawnResult,
): ProviderAttemptResult => ({
  code,
  exitCode: result?.exitCode ?? null,
  signal: result?.signal ?? null,
  status: "failed",
});

export class ProviderStepExecutor {
  readonly #adapter: ProviderDescriptorAdapter;
  readonly #commandHost: SpawnHost;
  readonly #environment: RunnerEnvironment;
  readonly #hydrator: PromptHydrator;
  readonly #policy: ProviderStepPolicy;

  constructor(
    commandHost: SpawnHost,
    environment: RunnerEnvironment,
    hydrator: PromptHydrator,
    adapter: ProviderDescriptorAdapter,
    policy: ProviderStepPolicy,
  ) {
    this.#commandHost = commandHost;
    this.#environment = environment;
    this.#hydrator = hydrator;
    this.#adapter = adapter;
    this.#policy = policy;
  }

  async execute(
    step: ProviderStep,
    descriptor: ProviderDescriptor,
    promptStep: PromptStep,
    environments: {
      readonly promptEnvironment: ChildEnvironment;
      readonly providerEnvironment: ChildEnvironment;
    },
    cancellation?: AbortSignal,
  ): Promise<ProviderAttemptResult> {
    const input = {
      ...(cancellation === undefined ? {} : { cancellation }),
      cwd: this.#environment.workingDirectoryFor(descriptor.command),
      descriptor,
      environment: environments.providerEnvironment,
      step,
      timeoutMs: this.#policy.timeoutMs,
    };
    try {
      await this.#adapter.prepare(input);
    } catch {
      return failed("provider-execution-failed");
    }

    let prompt: Uint8Array;
    try {
      prompt = (
        await this.#hydrator.hydrate(promptStep, environments.promptEnvironment)
      ).contents;
    } catch {
      return failed("prompt-hydration-failed");
    }

    try {
      await this.#hydrator.remove(step.renderedPromptId);
    } catch {
      return failed("prompt-cleanup-failed");
    }

    try {
      const command = this.#adapter.createProcess({
        ...input,
        prompt,
      });
      const result = await this.#commandHost.spawn({
        ...command,
        ...(cancellation === undefined ? {} : { cancellation }),
      }).completion;
      return succeeded(result)
        ? { status: "succeeded" }
        : failed("provider-execution-failed", result);
    } catch {
      return failed("provider-execution-failed");
    }
  }
}

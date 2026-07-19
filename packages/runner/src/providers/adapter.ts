import type { SpawnCommand } from "@agent-boot/process";
import type { ProviderDescriptor, ProviderStep } from "@agent-boot/protocol";

import type { ChildEnvironment } from "../steps/environment/index.js";

export interface ProviderAdapterInput {
  readonly cancellation?: AbortSignal;
  readonly cwd: string;
  readonly descriptor: ProviderDescriptor;
  readonly environment: ChildEnvironment;
  readonly prompt: Uint8Array;
  readonly step: ProviderStep;
  readonly timeoutMs: number;
}

export type ProviderPreparationInput = Omit<ProviderAdapterInput, "prompt">;

export interface ProviderDescriptorAdapter {
  prepare(input: ProviderPreparationInput): Promise<void>;
  createProcess(input: ProviderAdapterInput): SpawnCommand;
}

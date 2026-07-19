import type { SpawnCommand } from "@agent-boot/process";
import type { ProviderDescriptor, ProviderStep } from "@agent-boot/protocol";

import type { ChildEnvironment } from "../steps/environment/index.js";

export interface ProviderAdapterInput {
  readonly cwd: string;
  readonly descriptor: ProviderDescriptor;
  readonly environment: ChildEnvironment;
  readonly prompt: Uint8Array;
  readonly step: ProviderStep;
  readonly timeoutMs: number;
}

export interface ProviderDescriptorAdapter {
  createProcess(input: ProviderAdapterInput): SpawnCommand;
}

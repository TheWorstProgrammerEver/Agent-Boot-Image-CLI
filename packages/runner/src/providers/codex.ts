import type { SpawnCommand } from "@agent-boot/process";

import type {
  ProviderAdapterInput,
  ProviderDescriptorAdapter,
} from "./adapter.js";

/** Maps a serialized Codex provider descriptor to the shared process contract. */
export class CodexProviderAdapter implements ProviderDescriptorAdapter {
  createProcess(input: ProviderAdapterInput): SpawnCommand {
    return {
      arguments: input.descriptor.command.arguments,
      cwd: input.cwd,
      environment: input.environment,
      executable: input.descriptor.command.executable,
      forwardSignals: ["SIGHUP", "SIGINT", "SIGTERM"],
      label: `runner provider ${input.descriptor.id} step ${input.step.id}`,
      lifetime: { policy: "managed" },
      stdin: input.prompt,
      stdio: "stream",
      timeoutMs: input.timeoutMs,
    };
  }
}

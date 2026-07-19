import type { SpawnCommand } from "@agent-boot/process";

import type {
  ProviderAdapterInput,
  ProviderDescriptorAdapter,
  ProviderPreparationInput,
} from "../adapter.js";
import { CodexBootstrapError } from "./errors.js";
import type { CodexReadinessGate } from "./gate.js";

export const codexProviderArguments = (): readonly string[] => [
  "exec",
  "--profile",
  "agent-boot",
  "--strict-config",
  "--sandbox",
  "danger-full-access",
  "--ask-for-approval",
  "never",
  "-",
];

export class CodexProviderAdapter implements ProviderDescriptorAdapter {
  readonly #gate: CodexReadinessGate;

  constructor(gate: CodexReadinessGate) {
    this.#gate = gate;
  }

  async prepare(input: ProviderPreparationInput): Promise<void> {
    if (
      input.descriptor.command.workingDirectory === undefined ||
      input.descriptor.command.executable !== "codex" ||
      input.descriptor.command.arguments.join("\0") !==
        codexProviderArguments().join("\0")
    ) {
      throw new CodexBootstrapError("configuration");
    }
    await this.#gate.ensureReady(input);
  }

  createProcess(input: ProviderAdapterInput): SpawnCommand {
    return {
      arguments: codexProviderArguments(),
      cwd: input.cwd,
      environment: { ...input.environment, CODEX_HOME: undefined },
      executable: "codex",
      forwardSignals: ["SIGHUP", "SIGINT", "SIGTERM"],
      label: `runner provider ${input.descriptor.id} step ${input.step.id}`,
      lifetime: { policy: "managed" },
      stdin: input.prompt,
      stdio: "stream",
      timeoutMs: input.timeoutMs,
    };
  }
}

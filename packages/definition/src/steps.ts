import type { PublicEnvironmentKey } from "@agent-boot/protocol";
import type { CommandInput, DefinitionCommand } from "./command.js";
import type { PromptInput, PromptVariableInput, SecretInput } from "./resources.js";
import type { ProviderInput } from "./provider.js";

interface StepInputBase {
  readonly id: string;
}

interface StepBase {
  id: string;
}

export type EnvironmentStepInput =
  | (StepInputBase & {
      readonly kind: "environment";
      readonly operation: "set";
      readonly key: PublicEnvironmentKey;
      readonly value: string;
    })
  | (StepInputBase & {
      readonly kind: "environment";
      readonly operation: "unset";
      readonly key: PublicEnvironmentKey;
    });

export type EnvironmentStep =
  | (StepBase & {
      kind: "environment";
      operation: "set";
      key: PublicEnvironmentKey;
      value: string;
    })
  | (StepBase & {
      kind: "environment";
      operation: "unset";
      key: PublicEnvironmentKey;
    });

export interface AutomaticStepInput extends StepInputBase {
  readonly kind: "automatic";
  readonly command: CommandInput;
}

export interface AutomaticStep extends StepBase {
  kind: "automatic";
  command: DefinitionCommand;
}

export interface ManualStepInput extends StepInputBase {
  readonly kind: "manual";
  readonly command: CommandInput;
  readonly completionCheck: CommandInput;
  readonly pollIntervalSeconds: number;
}

export interface ManualStep extends StepBase {
  kind: "manual";
  command: DefinitionCommand;
  completionCheck: DefinitionCommand;
  pollIntervalSeconds: number;
}

export interface FireAndForgetStepInput extends StepInputBase {
  readonly kind: "fire-and-forget";
  readonly command: CommandInput;
  readonly lifetime: "runner";
}

export interface FireAndForgetStep extends StepBase {
  kind: "fire-and-forget";
  command: DefinitionCommand;
  lifetime: "runner";
}

export interface PromptVariableBindingInput {
  readonly name: string;
  readonly source: PromptVariableInput;
}

export interface PromptVariableBinding {
  name: string;
  source:
    | { kind: "environment"; key: PublicEnvironmentKey }
    | { kind: "secret"; secretId: string };
}

export interface PromptStepInput extends StepInputBase {
  readonly kind: "prompt";
  readonly templateId: string;
  readonly renderedPromptId: string;
  readonly retention: "ephemeral";
  readonly variables: readonly PromptVariableBindingInput[];
}

export interface PromptStep extends StepBase {
  kind: "prompt";
  templateId: string;
  renderedPromptId: string;
  retention: "ephemeral";
  variables: PromptVariableBinding[];
}

export interface ProviderStepInput extends StepInputBase {
  readonly kind: "provider";
  readonly providerId: string;
  readonly renderedPromptId: string;
}

export interface ProviderStep extends StepBase {
  kind: "provider";
  providerId: string;
  renderedPromptId: string;
}

export interface InstallUserSecretStepInput extends StepInputBase {
  readonly kind: "install-user-secret";
  readonly secret: SecretInput;
  readonly destination: string;
}

export interface InstallUserSecretStep extends StepBase {
  kind: "install-user-secret";
  secretId: string;
  destination: string;
}

export type SequenceStepInput =
  | EnvironmentStepInput
  | AutomaticStepInput
  | ManualStepInput
  | FireAndForgetStepInput
  | PromptStepInput
  | ProviderStepInput
  | InstallUserSecretStepInput;

export type SequenceStep =
  | EnvironmentStep
  | AutomaticStep
  | ManualStep
  | FireAndForgetStep
  | PromptStep
  | ProviderStep
  | InstallUserSecretStep;

export const setEnvironment = (
  id: string,
  key: PublicEnvironmentKey,
  value: string,
): EnvironmentStepInput => ({ id, kind: "environment", operation: "set", key, value });

export const unsetEnvironment = (
  id: string,
  key: PublicEnvironmentKey,
): EnvironmentStepInput => ({ id, kind: "environment", operation: "unset", key });

export const automatic = (id: string, stepCommand: CommandInput): AutomaticStepInput => ({
  id,
  kind: "automatic",
  command: stepCommand,
});

export const manual = (
  id: string,
  stepCommand: CommandInput,
  completionCheck: CommandInput,
  pollIntervalSeconds = 5,
): ManualStepInput => ({
  id,
  kind: "manual",
  command: stepCommand,
  completionCheck,
  pollIntervalSeconds,
});

export const fireAndForget = (
  id: string,
  stepCommand: CommandInput,
): FireAndForgetStepInput => ({
  id,
  kind: "fire-and-forget",
  command: stepCommand,
  lifetime: "runner",
});

export const promptVariable = (
  name: string,
  source: PromptVariableInput,
): PromptVariableBindingInput => ({ name, source });

export const renderPrompt = (
  id: string,
  template: PromptInput,
  renderedPromptId: string,
  variables: readonly PromptVariableBindingInput[],
): PromptStepInput => ({
  id,
  kind: "prompt",
  templateId: template.id,
  renderedPromptId,
  retention: "ephemeral",
  variables,
});

export const runProvider = (
  id: string,
  providerDefinition: ProviderInput,
  renderedPromptId: string,
): ProviderStepInput => ({
  id,
  kind: "provider",
  providerId: providerDefinition.id,
  renderedPromptId,
});

export const installUserSecret = (
  id: string,
  secretInput: SecretInput,
  destination: string,
): InstallUserSecretStepInput => ({
  id,
  kind: "install-user-secret",
  secret: secretInput,
  destination,
});

export const PROMPT_JOB_SCHEMA_VERSION = 1 as const;

export const SUPPORTED_PROMPT_JOB_MODELS = [
  "gpt-5.6-sol",
  "gpt-5.6-terra",
] as const;

export const SUPPORTED_REASONING_EFFORTS = [
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
] as const;

export type PromptJobModel = (typeof SUPPORTED_PROMPT_JOB_MODELS)[number];
export type PromptJobReasoningEffort = (typeof SUPPORTED_REASONING_EFFORTS)[number];
export type PromptJobEffectPolicy = "read-only";

export interface ScheduledPromptJob {
  readonly effectPolicy: PromptJobEffectPolicy;
  readonly id: string;
  readonly logRetention: number;
  readonly model: PromptJobModel;
  readonly onCalendar: string;
  readonly overlapGroup: string;
  readonly persistent: boolean;
  readonly prompt: string;
  readonly randomizedDelaySeconds: number;
  readonly reasoningEffort: PromptJobReasoningEffort;
  readonly timeoutSeconds: number;
  readonly workingDirectory: string;
}

export interface ScheduledPromptManifest {
  readonly jobs: readonly ScheduledPromptJob[];
  readonly version: typeof PROMPT_JOB_SCHEMA_VERSION;
}

export interface LoadedScheduledPromptJob extends ScheduledPromptJob {
  readonly promptPath: string;
  readonly workingDirectoryPath: string;
}

export interface LoadedScheduledPromptManifest {
  readonly jobs: readonly LoadedScheduledPromptJob[];
  readonly manifestPath: string;
  readonly promptRoot: string;
  readonly version: typeof PROMPT_JOB_SCHEMA_VERSION;
}

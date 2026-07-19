import type { SpawnHost } from "@agent-boot/process";

import type { PromptHydrator } from "../prompts/index.js";
import type { ProviderDescriptorAdapter } from "../providers/adapter.js";
import type { InstallUserSecretExecutorOptions } from "../steps/install-user-secret/index.js";

import type {
  FireAndForgetProcessEvent,
  RunnerCheckpoint,
  RunnerDiagnostic,
  RunnerPlanIdentity,
  SecretTransactionCheckpoint,
  StepCheckpoint,
} from "../state/index.js";
import type {
  FireAndForgetPolicy,
  ProcessIdentityHost,
} from "../steps/fire-and-forget/index.js";

export interface RunnerCheckpointStore {
  checkpointFireAndForgetProcess(
    plan: RunnerPlanIdentity,
    event: FireAndForgetProcessEvent,
  ): Promise<RunnerCheckpoint>;
  checkpointSecretTransaction(
    plan: RunnerPlanIdentity,
    checkpoint: SecretTransactionCheckpoint,
  ): Promise<RunnerCheckpoint>;
  checkpointStep(
    plan: RunnerPlanIdentity,
    checkpoint: StepCheckpoint,
  ): Promise<RunnerCheckpoint>;
  initialize(plan: RunnerPlanIdentity): Promise<RunnerCheckpoint>;
  markFailed(
    plan: RunnerPlanIdentity,
    diagnostic: RunnerDiagnostic,
  ): Promise<RunnerCheckpoint>;
  markSucceeded(plan: RunnerPlanIdentity): Promise<RunnerCheckpoint>;
}

export interface RunnerEnvironmentOptions {
  readonly basePath: string;
  readonly homeDirectory: string;
  readonly workingDirectory: string;
}

export interface AutomaticStepPolicy {
  readonly maxAttempts: number;
  readonly timeoutMs: number;
}

export interface ManualStepPolicy {
  readonly completionCheckTimeoutMs: number;
  readonly maximumPollIntervalMs: number;
}

export interface ProviderStepPolicy {
  readonly timeoutMs: number;
}

export interface ManualStepScheduler {
  sleep(delayMs: number, cancellation: AbortSignal): Promise<void>;
}

export type RunnerProgress =
  | {
      readonly attempt: number;
      readonly index: number;
      readonly status: "step-started" | "step-succeeded";
      readonly stepId: string;
    }
  | {
      readonly attempt: number;
      readonly diagnostic: RunnerDiagnostic;
      readonly index: number;
      readonly status: "step-failed";
      readonly stepId: string;
    }
  | {
      readonly check: number;
      readonly index: number;
      readonly status: "manual-completed";
      readonly stepId: string;
    }
  | {
      readonly check: number;
      readonly delayMs: number;
      readonly index: number;
      readonly status: "manual-check-retry";
      readonly stepId: string;
    }
  | {
      readonly index: number;
      readonly resumed: boolean;
      readonly status: "manual-waiting";
      readonly stepId: string;
    }
  | {
      readonly diagnostic: RunnerDiagnostic;
      readonly index: number;
      readonly status: "manual-terminal-failure";
      readonly stepId: string;
    }
  | {
      readonly deletionAssurance: "unlink-not-secure-erase";
      readonly index: number;
      readonly status: "secret-source-removed";
      readonly stepId: string;
    }
  | { readonly status: "runner-succeeded" }
  | {
      readonly diagnostic: RunnerDiagnostic;
      readonly status: "runner-failed";
    };

export interface RunnerEngineOptions {
  readonly automaticPolicy: AutomaticStepPolicy;
  readonly cancellation?: AbortSignal;
  readonly commandHost: SpawnHost;
  readonly environment: RunnerEnvironmentOptions;
  readonly fireAndForgetPolicy: FireAndForgetPolicy;
  readonly lifecycleWait?: (milliseconds: number, cancellation: AbortSignal) => Promise<void>;
  readonly manualPolicy: ManualStepPolicy;
  readonly manualScheduler?: ManualStepScheduler;
  readonly onProgress?: (progress: RunnerProgress) => void;
  readonly promptHydrator?: PromptHydrator;
  readonly providerAdapter?: ProviderDescriptorAdapter;
  readonly providerPolicy?: ProviderStepPolicy;
  readonly processIdentityHost?: ProcessIdentityHost;
  readonly serializedPlan: string | Uint8Array;
  readonly stateStore: RunnerCheckpointStore;
  readonly userSecretInstallation?: Omit<
    InstallUserSecretExecutorOptions,
    "accountHome" | "onRemovalDiagnostic"
  >;
}

export interface RunnerExecutionResult {
  readonly state: RunnerCheckpoint;
  readonly status: "failed" | "succeeded";
}

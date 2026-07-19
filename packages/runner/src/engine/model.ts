import type { SpawnHost } from "@agent-boot/process";

import type {
  RunnerCheckpoint,
  RunnerDiagnostic,
  RunnerPlanIdentity,
  StepCheckpoint,
} from "../state/index.js";

export interface RunnerCheckpointStore {
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
  | { readonly status: "runner-succeeded" }
  | {
      readonly diagnostic: RunnerDiagnostic;
      readonly status: "runner-failed";
    };

export interface RunnerEngineOptions {
  readonly automaticPolicy: AutomaticStepPolicy;
  readonly commandHost: SpawnHost;
  readonly environment: RunnerEnvironmentOptions;
  readonly onProgress?: (progress: RunnerProgress) => void;
  readonly serializedPlan: string | Uint8Array;
  readonly stateStore: RunnerCheckpointStore;
}

export interface RunnerExecutionResult {
  readonly state: RunnerCheckpoint;
  readonly status: "failed" | "succeeded";
}

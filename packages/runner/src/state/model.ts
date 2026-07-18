export const RUNNER_CHECKPOINT_SCHEMA_VERSION = 1 as const;

export interface RunnerPlanIdentity {
  readonly agentId: string;
  readonly planSha256: string;
  readonly schemaVersion: number;
}

export type StepCheckpointPhase = "started" | "succeeded" | "failed";

export interface StepCheckpoint {
  readonly attempt: number;
  readonly id: string;
  readonly index: number;
  readonly phase: StepCheckpointPhase;
}

export type SecretTransactionPhase =
  | "prepared"
  | "installed"
  | "source-removed"
  | "committed";

export interface SecretTransactionCheckpoint {
  readonly destination: string;
  readonly phase: SecretTransactionPhase;
  readonly secretId: string;
  readonly stepId: string;
}

export type RunnerDiagnosticCode =
  | "step-attempt-failed"
  | "secret-transaction-failed"
  | "state-persistence-failed"
  | "manual-intervention-required";

export type RunnerRecoveryAction =
  | "retry-step"
  | "resume-secret-transaction"
  | "inspect-state-storage"
  | "manual-intervention";

/**
 * Persisted diagnostics are deliberately structured: command output, exception messages,
 * environment values, and secret material have no field in the checkpoint schema.
 */
export interface RunnerDiagnostic {
  readonly attempt?: number;
  readonly code: RunnerDiagnosticCode;
  readonly exitCode?: number | null;
  readonly recovery: RunnerRecoveryAction;
  readonly signal?: NodeJS.Signals | null;
  readonly stepId?: string;
}

export type TerminalCheckpoint =
  | { readonly at: string; readonly status: "succeeded" }
  | {
      readonly at: string;
      readonly diagnostic: RunnerDiagnostic;
      readonly status: "failed";
    };

export interface RunnerCheckpoint {
  readonly currentStep: StepCheckpoint | null;
  readonly plan: RunnerPlanIdentity;
  readonly revision: number;
  readonly schemaVersion: typeof RUNNER_CHECKPOINT_SCHEMA_VERSION;
  readonly secretTransaction: SecretTransactionCheckpoint | null;
  readonly terminal: TerminalCheckpoint | null;
  readonly updatedAt: string;
}

export const RUNNER_CHECKPOINT_SCHEMA_VERSION = 2 as const;

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

export interface ProcessIdentity {
  readonly bootId: string;
  readonly pid: number;
  readonly processGroupId: number;
  readonly startTimeTicks: string;
}

export type FireAndForgetProcessPhase = "registered" | "accepted" | "finished";

export type FireAndForgetProcessOutcome =
  | "exited-before-acceptance"
  | "exited-after-acceptance"
  | "reconciled-missing"
  | "runner-shutdown";

export interface FireAndForgetProcessCheckpoint {
  readonly acceptedAt?: string;
  readonly exitCode?: number | null;
  readonly finishedAt?: string;
  readonly generation: number;
  readonly identity: ProcessIdentity;
  readonly lifetime: "runner";
  readonly outcome?: FireAndForgetProcessOutcome;
  readonly phase: FireAndForgetProcessPhase;
  readonly registeredAt: string;
  readonly signal?: NodeJS.Signals | null;
  readonly stepId: string;
  readonly stepIndex: number;
}

export type FireAndForgetProcessEvent =
  | {
      readonly generation: number;
      readonly identity: ProcessIdentity;
      readonly kind: "register";
      readonly stepId: string;
      readonly stepIndex: number;
    }
  | {
      readonly generation: number;
      readonly identity: ProcessIdentity;
      readonly kind: "accept";
      readonly stepId: string;
      readonly stepIndex: number;
    }
  | {
      readonly exitCode: number | null;
      readonly generation: number;
      readonly identity: ProcessIdentity;
      readonly kind: "finish";
      readonly outcome: FireAndForgetProcessOutcome;
      readonly signal: NodeJS.Signals | null;
      readonly stepId: string;
      readonly stepIndex: number;
    };

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
  | "manual-command-failed"
  | "manual-completion-check-failed"
  | "manual-gate-incomplete"
  | "prompt-cleanup-failed"
  | "prompt-hydration-failed"
  | "provider-execution-failed"
  | "fire-and-forget-launch-failed"
  | "fire-and-forget-early-exit"
  | "fire-and-forget-process-exited"
  | "fire-and-forget-reconciliation-failed"
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
  readonly fireAndForgetProcesses: readonly FireAndForgetProcessCheckpoint[];
  readonly plan: RunnerPlanIdentity;
  readonly revision: number;
  readonly schemaVersion: typeof RUNNER_CHECKPOINT_SCHEMA_VERSION;
  readonly secretTransaction: SecretTransactionCheckpoint | null;
  readonly terminal: TerminalCheckpoint | null;
  readonly updatedAt: string;
}

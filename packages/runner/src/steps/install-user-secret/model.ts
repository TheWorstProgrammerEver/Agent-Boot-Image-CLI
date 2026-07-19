import type { SecretTransactionCheckpoint } from "../../state/index.js";

export type UserSecretInstallStage =
  | "before-prepared-checkpoint"
  | "after-prepared-checkpoint"
  | "before-install"
  | "after-install"
  | "before-installed-checkpoint"
  | "after-installed-checkpoint"
  | "before-source-remove"
  | "after-source-remove"
  | "before-source-removed-checkpoint"
  | "after-source-removed-checkpoint"
  | "before-committed-checkpoint"
  | "after-committed-checkpoint";

export interface UserSecretInstallLifecycle {
  notify(stage: UserSecretInstallStage): void;
}

export type SecretTransactionWriter = (
  checkpoint: SecretTransactionCheckpoint,
) => Promise<unknown>;

export interface UserSecretRemovalDiagnostic {
  readonly deletionAssurance: "unlink-not-secure-erase";
  readonly status: "source-removed";
}

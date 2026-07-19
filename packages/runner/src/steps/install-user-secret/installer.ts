import { isAbsolute, resolve } from "node:path";

import type { InstallUserSecretStep } from "@agent-boot/protocol";

import type { SecretTransactionCheckpoint } from "../../state/index.js";
import { UserSecretDestinationStore } from "./destination-store.js";
import { UserSecretInstallError } from "./errors.js";
import {
  NodeUserSecretFileSystem,
  NodeUserSecretOwnership,
  type UserSecretFileSystem,
  type UserSecretOwnership,
} from "./filesystem.js";
import { closeQuietly } from "./io.js";
import type {
  SecretTransactionWriter,
  UserSecretInstallLifecycle,
  UserSecretInstallStage,
  UserSecretRemovalDiagnostic,
} from "./model.js";
import {
  BootstrapSecretStore,
  type BootstrapSecretLocation,
} from "./source-store.js";

export interface InstallUserSecretExecutorOptions {
  readonly accountGid: number;
  readonly accountHome: string;
  readonly accountUid: number;
  readonly fileSystem?: UserSecretFileSystem;
  readonly lifecycle?: UserSecretInstallLifecycle;
  readonly onRemovalDiagnostic?: (diagnostic: UserSecretRemovalDiagnostic) => void;
  readonly ownership?: UserSecretOwnership;
  /** Maps the logical filesystem root for isolated tests. Production must use the default. */
  readonly systemRoot?: string;
}

export class InstallUserSecretExecutor {
  readonly #destination: UserSecretDestinationStore;
  readonly #lifecycle: UserSecretInstallLifecycle | undefined;
  readonly #onRemovalDiagnostic:
    | ((diagnostic: UserSecretRemovalDiagnostic) => void)
    | undefined;
  readonly #source: BootstrapSecretStore;

  constructor(options: InstallUserSecretExecutorOptions) {
    if (
      !isAbsolute(options.accountHome) ||
      !Number.isSafeInteger(options.accountUid) ||
      options.accountUid < 0 ||
      !Number.isSafeInteger(options.accountGid) ||
      options.accountGid < 0 ||
      (options.systemRoot !== undefined && !isAbsolute(options.systemRoot))
    ) {
      throw new UserSecretInstallError("invalid-configuration");
    }
    const fileSystem = options.fileSystem ?? new NodeUserSecretFileSystem();
    const ownership = options.ownership ?? new NodeUserSecretOwnership();
    this.#destination = new UserSecretDestinationStore(
      fileSystem,
      ownership,
      resolve(options.accountHome),
      options.accountUid,
      options.accountGid,
    );
    this.#lifecycle = options.lifecycle;
    this.#onRemovalDiagnostic = options.onRemovalDiagnostic;
    this.#source = new BootstrapSecretStore(
      fileSystem,
      resolve(options.systemRoot ?? "/"),
    );
  }

  async execute(
    step: InstallUserSecretStep,
    recovered: SecretTransactionCheckpoint | null,
    checkpoint: SecretTransactionWriter,
  ): Promise<void> {
    const source = await this.#source.open(step.secretId);
    try {
      const destination = await this.#destination.pathFor(step.destination);
      let transaction = this.#recover(step, recovered);
      if (transaction === null) {
        await this.#source.read(source);
        transaction = this.#transaction(step, "prepared");
        await this.#checkpoint(transaction, checkpoint);
      }
      if (transaction.phase === "prepared") {
        this.#notify("before-install");
        const bootstrapSecret = await this.#source.read(source);
        await this.#destination.install(destination, bootstrapSecret.contents);
        await this.#destination.verify(destination, bootstrapSecret.contents);
        this.#notify("after-install");
        transaction = this.#transaction(step, "installed");
        await this.#checkpoint(transaction, checkpoint);
      }
      if (transaction.phase === "installed") {
        this.#notify("before-source-remove");
        const bootstrapSecret = await this.#source.readIfPresent(source);
        await this.#destination.verify(destination, bootstrapSecret?.contents);
        if (bootstrapSecret !== undefined) {
          await this.#source.remove(source, bootstrapSecret.status);
        }
        this.#notify("after-source-remove");
        this.#onRemovalDiagnostic?.({
          deletionAssurance: "unlink-not-secure-erase",
          status: "source-removed",
        });
        transaction = this.#transaction(step, "source-removed");
        await this.#checkpoint(transaction, checkpoint);
      }
      if (transaction.phase === "source-removed") {
        await this.#requireSourceAbsent(source);
        await this.#destination.verify(destination);
        transaction = this.#transaction(step, "committed");
        await this.#checkpoint(transaction, checkpoint);
      }
      if (transaction.phase === "committed") {
        await this.#requireSourceAbsent(source);
        await this.#destination.verify(destination);
      }
    } finally {
      await closeQuietly(source.directory);
    }
  }

  async #checkpoint(
    transaction: SecretTransactionCheckpoint,
    checkpoint: SecretTransactionWriter,
  ): Promise<void> {
    this.#notify(`before-${transaction.phase}-checkpoint`);
    await checkpoint(transaction);
    this.#notify(`after-${transaction.phase}-checkpoint`);
  }

  #recover(
    step: InstallUserSecretStep,
    recovered: SecretTransactionCheckpoint | null,
  ): SecretTransactionCheckpoint | null {
    if (recovered === null) return null;
    if (
      recovered.destination !== step.destination ||
      recovered.secretId !== step.secretId ||
      recovered.stepId !== step.id
    ) {
      throw new UserSecretInstallError("invalid-configuration");
    }
    return recovered;
  }

  async #requireSourceAbsent(source: BootstrapSecretLocation): Promise<void> {
    if (await this.#source.exists(source)) {
      throw new UserSecretInstallError("verification-failed");
    }
  }

  #transaction(
    step: InstallUserSecretStep,
    phase: SecretTransactionCheckpoint["phase"],
  ): SecretTransactionCheckpoint {
    return {
      destination: step.destination,
      phase,
      secretId: step.secretId,
      stepId: step.id,
    };
  }

  #notify(stage: UserSecretInstallStage): void {
    this.#lifecycle?.notify(stage);
  }
}

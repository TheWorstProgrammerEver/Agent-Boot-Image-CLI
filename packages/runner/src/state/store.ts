import {
  cleanupCheckpointTemps,
  inspectCheckpointDirectory,
  writeFileAtomically,
} from "./atomic-file.js";
import { type Clock, SystemClock } from "./clock.js";
import { CheckpointValidationError, StateAccessError, UnsafeRecoveryError } from "./errors.js";
import { NodeStateFileSystem, type StateFileSystem } from "./filesystem.js";
import {
  RUNNER_CHECKPOINT_SCHEMA_VERSION,
  type FireAndForgetProcessEvent,
  type RunnerCheckpoint,
  type RunnerDiagnostic,
  type RunnerPlanIdentity,
  type SecretTransactionCheckpoint,
  type StepCheckpoint,
} from "./model.js";
import { samePlanIdentity } from "./plan-identity.js";
import { checkpointSchemaVersion, parseRunnerCheckpoint } from "./schema.js";
import {
  initializeCheckpoint,
  transitionFireAndForgetProcess,
  transitionSecretTransaction,
  transitionStep,
  transitionTerminalFailure,
  transitionTerminalSuccess,
} from "./transitions.js";

const MAX_CHECKPOINT_BYTES = 64 * 1024;

export type CheckpointInspection =
  | { readonly status: "absent" }
  | { readonly state: RunnerCheckpoint; readonly status: "valid" }
  | {
      readonly expectedPlan: RunnerPlanIdentity;
      readonly recordedPlan: RunnerPlanIdentity;
      readonly state: RunnerCheckpoint;
      readonly status: "stale-plan";
    }
  | { readonly foundVersion: number; readonly status: "incompatible" }
  | { readonly diagnostic: string; readonly status: "corrupt" }
  | { readonly mode: number; readonly status: "unsafe-permissions" }
  | { readonly mode: number; readonly status: "unsafe-directory-permissions" }
  | {
      readonly actualOwner: number;
      readonly expectedOwner: number;
      readonly status: "unsafe-directory-owner";
    };

export interface RunnerStateStoreOptions {
  readonly clock?: Clock;
  readonly fileSystem?: StateFileSystem;
  readonly path: string;
}

const errorCode = (error: unknown): string | undefined =>
  typeof (error as NodeJS.ErrnoException).code === "string"
    ? (error as NodeJS.ErrnoException).code
    : undefined;

const accessError = (operation: string, error: unknown): StateAccessError =>
  new StateAccessError(operation, errorCode(error), { cause: error });

const recoveryError = (inspection: Exclude<CheckpointInspection, { status: "valid" }>): never => {
  switch (inspection.status) {
    case "absent":
      throw new UnsafeRecoveryError(
        "checkpoint is absent",
        "Initialize the store before recording progress.",
      );
    case "stale-plan":
      throw new UnsafeRecoveryError(
        "checkpoint belongs to a different runner plan",
        "Restore the matching assembly or explicitly archive the stale checkpoint before starting over.",
      );
    case "incompatible":
      throw new UnsafeRecoveryError(
        `checkpoint schema version ${String(inspection.foundVersion)} is unsupported`,
        `Use a runner that supports it or migrate it to version ${String(RUNNER_CHECKPOINT_SCHEMA_VERSION)}.`,
      );
    case "corrupt":
      throw new UnsafeRecoveryError(
        `checkpoint is corrupt (${inspection.diagnostic})`,
        "Preserve it for diagnosis and restore a known-good checkpoint; do not resume execution.",
      );
    case "unsafe-permissions":
      throw new UnsafeRecoveryError(
        `checkpoint permissions are ${inspection.mode.toString(8)}`,
        "Set the state file mode to 0600 and verify its ownership before resuming.",
      );
    case "unsafe-directory-permissions":
      throw new UnsafeRecoveryError(
        `checkpoint directory permissions are ${inspection.mode.toString(8)}`,
        "Remove group/other write access and verify the directory ownership before resuming.",
      );
    case "unsafe-directory-owner":
      throw new UnsafeRecoveryError(
        "checkpoint directory is owned by a different user",
        "Restore the state directory to the runner user before resuming.",
      );
  }
};

export class RunnerStateStore {
  readonly #clock: Clock;
  readonly #fileSystem: StateFileSystem;
  readonly #ownerUid: number;
  readonly #path: string;
  #tail: Promise<void> = Promise.resolve();

  constructor(options: RunnerStateStoreOptions) {
    if (options.path.length === 0) throw new TypeError("path must not be empty");
    if (process.getuid === undefined) {
      throw new TypeError("runner checkpoint storage requires POSIX owner identifiers");
    }
    this.#clock = options.clock ?? new SystemClock();
    this.#fileSystem = options.fileSystem ?? new NodeStateFileSystem();
    this.#ownerUid = process.getuid();
    this.#path = options.path;
  }

  inspect(expectedPlan: RunnerPlanIdentity): Promise<CheckpointInspection> {
    return this.#serialize(() => this.#inspect(expectedPlan));
  }

  initialize(plan: RunnerPlanIdentity): Promise<RunnerCheckpoint> {
    return this.#serialize(async () => {
      const inspection = await this.#inspect(plan);
      if (inspection.status === "valid") return inspection.state;
      if (inspection.status !== "absent") return recoveryError(inspection);
      const state = initializeCheckpoint(plan, this.#timestamp());
      await this.#persist(state);
      return state;
    });
  }

  checkpointStep(plan: RunnerPlanIdentity, checkpoint: StepCheckpoint): Promise<RunnerCheckpoint> {
    return this.#update(plan, (state, updatedAt) => transitionStep(state, checkpoint, updatedAt));
  }

  checkpointFireAndForgetProcess(
    plan: RunnerPlanIdentity,
    event: FireAndForgetProcessEvent,
  ): Promise<RunnerCheckpoint> {
    return this.#update(plan, (state, updatedAt) =>
      transitionFireAndForgetProcess(state, event, updatedAt),
    );
  }

  checkpointSecretTransaction(
    plan: RunnerPlanIdentity,
    checkpoint: SecretTransactionCheckpoint,
  ): Promise<RunnerCheckpoint> {
    return this.#update(plan, (state, updatedAt) =>
      transitionSecretTransaction(state, checkpoint, updatedAt),
    );
  }

  markSucceeded(plan: RunnerPlanIdentity): Promise<RunnerCheckpoint> {
    return this.#update(plan, transitionTerminalSuccess);
  }

  markFailed(
    plan: RunnerPlanIdentity,
    diagnostic: RunnerDiagnostic,
  ): Promise<RunnerCheckpoint> {
    return this.#update(plan, (state, updatedAt) =>
      transitionTerminalFailure(state, diagnostic, updatedAt),
    );
  }

  #update(
    plan: RunnerPlanIdentity,
    transition: (state: RunnerCheckpoint, updatedAt: string) => RunnerCheckpoint,
  ): Promise<RunnerCheckpoint> {
    return this.#serialize(async () => {
      const state = await this.#requireValid(plan);
      const next = transition(state, this.#timestamp());
      if (next === state) return state;
      await this.#persist(next);
      return next;
    });
  }

  async #inspect(expectedPlan: RunnerPlanIdentity): Promise<CheckpointInspection> {
    let directoryInspection;
    try {
      directoryInspection = await inspectCheckpointDirectory(
        this.#fileSystem,
        this.#path,
        this.#ownerUid,
      );
    } catch (error) {
      throw accessError("inspect state directory", error);
    }
    switch (directoryInspection.status) {
      case "absent":
        return { status: "absent" };
      case "corrupt":
        return directoryInspection;
      case "unsafe-permissions":
        return {
          mode: directoryInspection.mode,
          status: "unsafe-directory-permissions",
        };
      case "unsafe-owner":
        return {
          actualOwner: directoryInspection.actualOwner,
          expectedOwner: directoryInspection.expectedOwner,
          status: "unsafe-directory-owner",
        };
      case "valid":
        break;
    }

    try {
      await cleanupCheckpointTemps(this.#fileSystem, this.#path);
    } catch (error) {
      throw accessError("clean temporary state files", error);
    }

    let stat;
    try {
      stat = await this.#fileSystem.lstat(this.#path);
    } catch (error) {
      if (errorCode(error) === "ENOENT") return { status: "absent" };
      throw accessError("inspect", error);
    }
    if (!stat.isFile() || stat.isSymbolicLink()) {
      return { diagnostic: "state path is not a regular file", status: "corrupt" };
    }
    const mode = stat.mode & 0o777;
    if (mode !== 0o600) return { mode, status: "unsafe-permissions" };
    if (stat.size > MAX_CHECKPOINT_BYTES) {
      return { diagnostic: "state file exceeds the 64 KiB limit", status: "corrupt" };
    }

    let contents: string;
    try {
      contents = await this.#fileSystem.readFile(this.#path, "utf8");
    } catch (error) {
      if (errorCode(error) === "ENOENT") return { status: "absent" };
      throw accessError("read", error);
    }
    let document: unknown;
    try {
      document = JSON.parse(contents);
    } catch {
      return { diagnostic: "state file is not valid JSON", status: "corrupt" };
    }
    const version = checkpointSchemaVersion(document);
    if (typeof version === "number" && version !== RUNNER_CHECKPOINT_SCHEMA_VERSION) {
      return { foundVersion: version, status: "incompatible" };
    }
    let state: RunnerCheckpoint;
    try {
      state = parseRunnerCheckpoint(document);
    } catch (error) {
      if (error instanceof CheckpointValidationError) {
        return { diagnostic: "state document does not match its schema", status: "corrupt" };
      }
      throw error;
    }
    return samePlanIdentity(state.plan, expectedPlan)
      ? { state, status: "valid" }
      : {
          expectedPlan,
          recordedPlan: state.plan,
          state,
          status: "stale-plan",
        };
  }

  async #persist(state: RunnerCheckpoint): Promise<void> {
    try {
      await writeFileAtomically(
        this.#fileSystem,
        this.#path,
        `${JSON.stringify(state, null, 2)}\n`,
        this.#ownerUid,
      );
    } catch (error) {
      throw accessError("persist", error);
    }
  }

  async #requireValid(plan: RunnerPlanIdentity): Promise<RunnerCheckpoint> {
    const inspection = await this.#inspect(plan);
    if (inspection.status === "valid") return inspection.state;
    return recoveryError(inspection);
  }

  #serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#tail.then(operation, operation);
    this.#tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  #timestamp(): string {
    return this.#clock.now().toISOString();
  }
}

export class RunnerStateError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "RunnerStateError";
  }
}

export class CheckpointValidationError extends RunnerStateError {
  constructor(message: string) {
    super(`Invalid runner checkpoint: ${message}`);
    this.name = "CheckpointValidationError";
  }
}

export class StateAccessError extends RunnerStateError {
  readonly operation: string;

  constructor(operation: string, code?: string, options?: ErrorOptions) {
    super(
      `Cannot ${operation} runner checkpoint${code === undefined ? "" : ` (${code})`}. ` +
        "Inspect the state directory ownership, permissions, and available storage.",
      options,
    );
    this.name = "StateAccessError";
    this.operation = operation;
  }
}

export class UnsafeRecoveryError extends RunnerStateError {
  readonly reason: string;

  constructor(reason: string, guidance: string) {
    super(`Runner checkpoint recovery stopped: ${reason}. ${guidance}`);
    this.name = "UnsafeRecoveryError";
    this.reason = reason;
  }
}

export class StateTransitionError extends RunnerStateError {
  constructor(message: string) {
    super(`Invalid runner checkpoint transition: ${message}`);
    this.name = "StateTransitionError";
  }
}

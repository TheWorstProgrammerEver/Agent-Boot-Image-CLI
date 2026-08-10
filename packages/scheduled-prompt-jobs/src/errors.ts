export class PromptJobValidationError extends Error {
  readonly path: string;

  constructor(path: string, reason: string) {
    super(`Scheduled prompt manifest validation failed at ${path}: ${reason}`);
    this.name = "PromptJobValidationError";
    this.path = path;
  }
}

export class PromptJobOperationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PromptJobOperationError";
  }
}

export class PromptJobUnitRecoveryError extends Error {
  readonly recoveryPath: string;

  constructor(recoveryPath: string) {
    super("Prompt-job unit rollback did not complete; inspect the preserved recovery path before retrying.");
    this.name = "PromptJobUnitRecoveryError";
    this.recoveryPath = recoveryPath;
  }
}

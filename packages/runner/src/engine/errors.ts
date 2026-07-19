export type RunnerPlanFailureReason = "invalid-json" | "invalid-plan";

export class RunnerPlanError extends Error {
  readonly reason: RunnerPlanFailureReason;

  constructor(reason: RunnerPlanFailureReason) {
    const guidance =
      reason === "invalid-json"
        ? "Restore runner-plan.json from a validated assembly."
        : "Use a runner compatible with the validated assembly protocol.";
    super(`Runner plan rejected (${reason}). ${guidance}`);
    this.name = "RunnerPlanError";
    this.reason = reason;
  }
}

export class RunnerConfigurationError extends Error {
  constructor(field: string, requirement: string) {
    super(`Invalid runner configuration for ${field}: ${requirement}.`);
    this.name = "RunnerConfigurationError";
  }
}

export class RunnerInterruptedError extends Error {
  constructor() {
    super("Runner execution was interrupted; supervised processes were stopped.");
    this.name = "RunnerInterruptedError";
  }
}

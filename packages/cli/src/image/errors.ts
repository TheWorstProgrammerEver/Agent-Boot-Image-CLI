export type ImageWorkflowPhase =
  | "artifact-acquisition"
  | "check"
  | "cleanup"
  | "confirmation"
  | "customize"
  | "lock"
  | "os-resolution"
  | "preflight"
  | "preparation"
  | "recheck"
  | "synthesis"
  | "validation"
  | "verify"
  | "write";

export type ImageRecoveryState =
  | "complete"
  | "target-incomplete"
  | "target-unchanged"
  | "target-verified-needs-customization";

export class ImageWorkflowError extends Error {
  readonly canceled: boolean;
  readonly cleanupFailed: boolean;
  readonly phase: ImageWorkflowPhase;
  readonly recovery: ImageRecoveryState;

  constructor(
    phase: ImageWorkflowPhase,
    recovery: ImageRecoveryState,
    options: ErrorOptions & {
      readonly canceled?: boolean;
      readonly cleanupFailed?: boolean;
    } = {},
  ) {
    super(`Image workflow failed during ${phase}.`, options);
    this.name = "ImageWorkflowError";
    this.phase = phase;
    this.recovery = recovery;
    this.canceled = options.canceled ?? false;
    this.cleanupFailed = options.cleanupFailed ?? false;
  }
}

export const asImageWorkflowError = (
  error: unknown,
  phase: ImageWorkflowPhase,
  recovery: ImageRecoveryState,
): ImageWorkflowError => error instanceof ImageWorkflowError
  ? error
  : new ImageWorkflowError(phase, recovery, { cause: error });

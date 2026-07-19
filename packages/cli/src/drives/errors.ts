export type DriveGuardrailCode =
  | "active-system-disk"
  | "active-root-unresolved"
  | "confirmation-rejected"
  | "descendant-mounted"
  | "identity-changed"
  | "invalid-constraints"
  | "model-mismatch"
  | "not-removable"
  | "not-whole-disk"
  | "serial-mismatch"
  | "size-limit-exceeded"
  | "target-not-found"
  | "transport-mismatch"
  | "unstable-target";

export class DriveGuardrailError extends Error {
  readonly code: DriveGuardrailCode;

  constructor(code: DriveGuardrailCode, message: string) {
    super(message);
    this.name = "DriveGuardrailError";
    this.code = code;
  }
}

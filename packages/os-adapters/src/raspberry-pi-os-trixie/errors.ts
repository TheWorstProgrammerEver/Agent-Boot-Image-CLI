export type RaspberryPiOsAdapterErrorCode =
  | "incompatible-image"
  | "insufficient-capacity"
  | "invalid-input"
  | "password-hash-failed"
  | "postcondition-failed"
  | "unsafe-path";

export class RaspberryPiOsAdapterError extends Error {
  readonly code: RaspberryPiOsAdapterErrorCode;

  constructor(code: RaspberryPiOsAdapterErrorCode, message: string) {
    super(message);
    this.name = "RaspberryPiOsAdapterError";
    this.code = code;
  }
}

export interface RaspberryPiOsCapacityDetails {
  readonly availableBlocks: bigint;
  readonly availableInodes: bigint;
  readonly blockSize: bigint;
  readonly requiredAdditionalBytes: bigint;
  readonly requiredBlocks: bigint;
  readonly requiredInodes: bigint;
}

export class RaspberryPiOsCapacityError extends RaspberryPiOsAdapterError {
  readonly details: RaspberryPiOsCapacityDetails;
  readonly role: string;

  constructor(role: string, details: RaspberryPiOsCapacityDetails) {
    super("insufficient-capacity", `The ${role} filesystem lacks capacity for the complete customization plan.`);
    this.name = "RaspberryPiOsCapacityError";
    this.details = details;
    this.role = role;
  }
}

export const adapterError = (
  code: RaspberryPiOsAdapterErrorCode,
  message: string,
): RaspberryPiOsAdapterError => new RaspberryPiOsAdapterError(code, message);

export type RaspberryPiOsAdapterErrorCode =
  | "incompatible-image"
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

export const adapterError = (
  code: RaspberryPiOsAdapterErrorCode,
  message: string,
): RaspberryPiOsAdapterError => new RaspberryPiOsAdapterError(code, message);

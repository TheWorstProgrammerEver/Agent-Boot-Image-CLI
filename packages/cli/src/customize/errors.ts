export type ImageCustomizationErrorCode =
  | "adapter-failed"
  | "canceled"
  | "cleanup-failed"
  | "filesystem-check-failed"
  | "invalid-input"
  | "mount-failed"
  | "partition-layout"
  | "partition-timeout"
  | "postcondition-failed"
  | "temporary-root-failed";

const messages: Readonly<Record<ImageCustomizationErrorCode, string>> = {
  "adapter-failed": "The image adapter did not complete customization.",
  canceled: "Image customization was canceled.",
  "cleanup-failed": "Image customization cleanup did not complete.",
  "filesystem-check-failed": "A final read-only filesystem check failed.",
  "invalid-input": "Image customization input is invalid or unsupported.",
  "mount-failed": "An image partition could not be mounted safely.",
  "partition-layout": "Image partitions do not match the locked operating system.",
  "partition-timeout": "Image partitions did not become available before the deadline.",
  "postcondition-failed": "Image adapter postconditions did not pass.",
  "temporary-root-failed": "The private mount root could not be prepared.",
};

export class ImageCustomizationError extends Error {
  readonly code: ImageCustomizationErrorCode;

  constructor(code: ImageCustomizationErrorCode, options?: ErrorOptions) {
    super(messages[code], options);
    this.name = "ImageCustomizationError";
    this.code = code;
  }
}

export const customizationError = (code: ImageCustomizationErrorCode): ImageCustomizationError =>
  new ImageCustomizationError(code);

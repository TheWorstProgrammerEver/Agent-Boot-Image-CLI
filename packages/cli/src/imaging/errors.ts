export type ImageWriteErrorCode =
  | "canceled"
  | "cleanup-failed"
  | "invalid-byte-count"
  | "lock-contention"
  | "lock-failed"
  | "read-back-mismatch"
  | "short-read"
  | "short-write"
  | "source-failed"
  | "source-size-mismatch"
  | "target-access"
  | "target-too-small"
  | "unmount-failed"
  | "write-sync-failed";

export class ImageWriteError extends Error {
  readonly code: ImageWriteErrorCode;

  constructor(code: ImageWriteErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ImageWriteError";
    this.code = code;
  }
}

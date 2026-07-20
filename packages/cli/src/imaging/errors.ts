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
  readonly cleanupOnly: boolean;
  readonly completedPhase: "verify" | undefined;

  constructor(
    code: ImageWriteErrorCode,
    message: string,
    options: ErrorOptions & {
      readonly cleanupOnly?: boolean;
      readonly completedPhase?: "verify";
    } = {},
  ) {
    super(message, options);
    this.name = "ImageWriteError";
    this.code = code;
    this.cleanupOnly = options.cleanupOnly ?? false;
    this.completedPhase = options.completedPhase;
  }
}

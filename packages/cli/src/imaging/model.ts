import type { AuthorizedImageTarget, ConfirmedImageTargetPlan } from "../drives/index.js";

export type ImageWritePhase = "unmount" | "write" | "verify";

export interface ImageWriteProgress {
  readonly completed: number;
  readonly phase: ImageWritePhase;
  readonly total: number;
  readonly unit: "bytes" | "mounts";
}

export interface ImageByteStream {
  readonly chunks: AsyncIterable<Uint8Array>;
  readonly completion: Promise<void>;
  cancel(): void;
}

export interface RepeatableImageSource {
  open(cancellation: AbortSignal): ImageByteStream;
}

export interface DeviceOperationLock {
  release(): Promise<void>;
}

export interface DeviceOperationLocker {
  acquire(target: AuthorizedImageTarget, cancellation: AbortSignal): Promise<DeviceOperationLock>;
}

export interface DescendantUnmounter {
  unmount(mountpoint: string, cancellation: AbortSignal): Promise<void>;
}

export interface RawImageWriter {
  write(options: RawImageWriteOptions): Promise<number>;
}

export interface RawImageWriteOptions {
  readonly cancellation: AbortSignal;
  readonly expectedByteLength: number;
  readonly onProgress?: (progress: ImageWriteProgress) => void;
  readonly source: RepeatableImageSource;
  readonly targetPath: string;
}

export interface ReadBackVerifier {
  verify(options: ReadBackVerifyOptions): Promise<number>;
}

export type ReadBackVerifyOptions = RawImageWriteOptions;

export interface ImageWriteTransactionRequest<AfterVerifyResult = undefined> {
  readonly afterVerify?: (result: {
    readonly bytesVerified: number;
    readonly bytesWritten: number;
    readonly cancellation: AbortSignal;
    readonly target: AuthorizedImageTarget;
  }) => Promise<AfterVerifyResult>;
  readonly cancellation?: AbortSignal;
  readonly expectedByteLength: number;
  readonly onProgress?: (progress: ImageWriteProgress) => void;
  readonly plan: ConfirmedImageTargetPlan;
  readonly source: RepeatableImageSource;
}

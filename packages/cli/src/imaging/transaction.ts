import type { DriveInspector } from "@agent-boot/os-linux";
import type { SignalSource } from "@agent-boot/process";

import { assertConfirmedImageTargetPlan } from "../drives/confirmation.js";
import { DriveGuardrailError } from "../drives/errors.js";
import {
  recheckImageTargetForWrite,
  type AuthorizedImageTarget,
  type RecheckedImageTarget,
} from "../drives/preflight.js";
import { ImageWriteError } from "./errors.js";
import type {
  DescendantUnmounter,
  DeviceOperationLocker,
  ImageWriteProgress,
  ImageWriteTransactionRequest,
  RawImageWriter,
  ReadBackVerifier,
} from "./model.js";
import { throwIfCanceled, validateByteLength } from "./stream.js";

const forwardedSignals = ["SIGHUP", "SIGINT", "SIGTERM"] as const;

export interface ImageWriteTransactionDependencies {
  readonly inspector: DriveInspector;
  readonly locker: DeviceOperationLocker;
  readonly signalSource?: SignalSource;
  readonly unmounter: DescendantUnmounter;
  readonly verifier: ReadBackVerifier;
  readonly writer: RawImageWriter;
}

export interface ImageWriteTransactionResult<AfterVerifyResult = undefined> {
  readonly afterVerifyResult: AfterVerifyResult;
  readonly bytesVerified: number;
  readonly bytesWritten: number;
  readonly target: AuthorizedImageTarget;
}

const deepestMountFirst = (mountpoints: readonly string[]): readonly string[] =>
  [...mountpoints].sort((left, right) =>
    right.split("/").length - left.split("/").length || right.length - left.length);

const unmountDescendants = async (
  plan: ImageWriteTransactionRequest["plan"],
  inspector: DriveInspector,
  unmounter: DescendantUnmounter,
  cancellation: AbortSignal,
  onProgress?: (progress: ImageWriteProgress) => void,
): Promise<RecheckedImageTarget> => {
  const attempted = new Set<string>();

  for (;;) {
    throwIfCanceled(cancellation);
    const current = await recheckImageTargetForWrite(plan, inspector);
    throwIfCanceled(cancellation);
    const mountpoint = deepestMountFirst(current.mountedDescendantMountpoints)[0];
    if (mountpoint === undefined) return current;
    if (attempted.has(mountpoint)) {
      throw new ImageWriteError(
        "unmount-failed",
        "A target descendant remained mounted after unmount completed.",
      );
    }
    attempted.add(mountpoint);
    await unmounter.unmount(mountpoint, cancellation);
    onProgress?.({
      completed: attempted.size,
      phase: "unmount",
      total: attempted.size + current.mountedDescendantMountpoints.length - 1,
      unit: "mounts",
    });
  }
};

const targetFromPlan = (request: ImageWriteTransactionRequest<unknown>): AuthorizedImageTarget => ({
  resolvedTarget: request.plan.resolvedTarget,
  sizeBytes: request.plan.sizeBytes,
  stableTarget: request.plan.stableTarget,
});

const cleanupFailure = (
  operationError: Error | undefined,
  errors: readonly unknown[],
  completedPhase: "verify" | undefined,
): ImageWriteError => new ImageWriteError(
  "cleanup-failed",
  "Image write transaction cleanup did not complete.",
  {
    cause: new AggregateError(operationError === undefined ? errors : [operationError, ...errors]),
    cleanupOnly: operationError === undefined,
    ...(completedPhase === undefined ? {} : { completedPhase }),
  },
);

export const writeImageTransaction = async <AfterVerifyResult = undefined>(
  request: ImageWriteTransactionRequest<AfterVerifyResult>,
  dependencies: ImageWriteTransactionDependencies,
): Promise<ImageWriteTransactionResult<AfterVerifyResult>> => {
  assertConfirmedImageTargetPlan(request.plan);
  validateByteLength(request.expectedByteLength);
  if (request.expectedByteLength > request.plan.sizeBytes) {
    throw new ImageWriteError("target-too-small", "Verified image is larger than the target device.");
  }

  const cancellation = new AbortController();
  const abort = (): void => { cancellation.abort(); };
  request.cancellation?.addEventListener("abort", abort, { once: true });
  if (request.cancellation?.aborted === true) abort();

  const signalSource = dependencies.signalSource ?? process;
  const signalListeners = new Map<NodeJS.Signals, () => void>();
  for (const signal of forwardedSignals) {
    const listener = (): void => { cancellation.abort(); };
    signalListeners.set(signal, listener);
    signalSource.on(signal, listener);
  }

  let lock: Awaited<ReturnType<DeviceOperationLocker["acquire"]>> | undefined;
  let operationError: Error | undefined;
  let result: ImageWriteTransactionResult<AfterVerifyResult> | undefined;
  let completedPhase: "verify" | undefined;
  const cleanupErrors: unknown[] = [];

  try {
    throwIfCanceled(cancellation.signal);
    lock = await dependencies.locker.acquire(targetFromPlan(request), cancellation.signal);
    throwIfCanceled(cancellation.signal);

    const target = await unmountDescendants(
      request.plan,
      dependencies.inspector,
      dependencies.unmounter,
      cancellation.signal,
      request.onProgress,
    );
    throwIfCanceled(cancellation.signal);

    const bytesWritten = await dependencies.writer.write({
      cancellation: cancellation.signal,
      expectedByteLength: request.expectedByteLength,
      ...(request.onProgress === undefined ? {} : { onProgress: request.onProgress }),
      source: request.source,
      targetPath: target.resolvedTarget,
    });
    throwIfCanceled(cancellation.signal);

    const bytesVerified = await dependencies.verifier.verify({
      cancellation: cancellation.signal,
      expectedByteLength: request.expectedByteLength,
      ...(request.onProgress === undefined ? {} : { onProgress: request.onProgress }),
      source: request.source,
      targetPath: target.resolvedTarget,
    });
    throwIfCanceled(cancellation.signal);

    if (bytesWritten !== request.expectedByteLength || bytesVerified !== request.expectedByteLength) {
      throw new ImageWriteError(
        "source-size-mismatch",
        "Writer or verifier reported an inexact image byte count.",
      );
    }
    const customizationTarget = await recheckImageTargetForWrite(request.plan, dependencies.inspector);
    throwIfCanceled(cancellation.signal);
    completedPhase = "verify";
    const afterVerifyResult = request.afterVerify === undefined
      ? undefined as AfterVerifyResult
      : await request.afterVerify({
          bytesVerified,
          bytesWritten,
          cancellation: cancellation.signal,
          target: customizationTarget,
        });
    throwIfCanceled(cancellation.signal);
    result = { afterVerifyResult, bytesVerified, bytesWritten, target: customizationTarget };
  } catch (error) {
    operationError = error instanceof Error
      ? error
      : new ImageWriteError("cleanup-failed", "Transaction failed with a non-error value.");
  } finally {
    if (lock !== undefined) {
      try {
        await unmountDescendants(
          request.plan,
          dependencies.inspector,
          dependencies.unmounter,
          new AbortController().signal,
        );
      } catch (error) {
        if (!(operationError instanceof DriveGuardrailError && error instanceof DriveGuardrailError)) {
          cleanupErrors.push(error);
        }
      }
      try {
        await lock.release();
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    request.cancellation?.removeEventListener("abort", abort);
    for (const [signal, listener] of signalListeners) signalSource.off(signal, listener);
  }

  if (cleanupErrors.length > 0) {
    throw cleanupFailure(operationError, cleanupErrors, completedPhase);
  }
  if (operationError !== undefined) throw operationError;
  if (result === undefined) throw new ImageWriteError("cleanup-failed", "Transaction produced no result.");
  return result;
};

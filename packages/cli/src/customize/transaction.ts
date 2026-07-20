import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import {
  customizationError,
  ImageCustomizationError,
  type ImageCustomizationErrorCode,
} from "./errors.js";
import { SystemPrivateMountRootFactory } from "./mount-root.js";
import type {
  CustomizeWrittenImageDependencies,
  CustomizeWrittenImageRequest,
  CustomizeWrittenImageResult,
  MountedCustomizationPartition,
  PrivateMountRoot,
  ValidatedImagePartition,
} from "./model.js";
import { resolveCustomizationOsLock } from "./os-lock.js";
import { waitForImagePartitions } from "./partitions.js";

const forwardedSignals = ["SIGHUP", "SIGINT", "SIGTERM"] as const;

const sanitizedError = (
  code: ImageCustomizationErrorCode,
  cancellation: AbortSignal,
): ImageCustomizationError => cancellation.aborted
  ? customizationError("canceled")
  : customizationError(code);

const cleanupFailure = (
  operationError: ImageCustomizationError | undefined,
  count: number,
): ImageCustomizationError => new ImageCustomizationError("cleanup-failed", {
  cause: new AggregateError([
    ...(operationError === undefined ? [] : [operationError]),
    ...Array.from({ length: count }, () => customizationError("cleanup-failed")),
  ]),
});

const mountPathFor = (root: string, partition: ValidatedImagePartition): string =>
  join(root, partition.role);

const assertAdapterPostconditions = (
  result: Awaited<ReturnType<CustomizeWrittenImageDependencies["adapter"]["customize"]>>,
): void => {
  if (result.assertions.length === 0 || result.assertions.some(assertion =>
    assertion.id.length === 0 || !assertion.path.startsWith("/"))) {
    throw customizationError("postcondition-failed");
  }
};

export const customizeWrittenImage = async (
  request: CustomizeWrittenImageRequest,
  dependencies: CustomizeWrittenImageDependencies,
): Promise<CustomizeWrittenImageResult> => {
  const osLock = resolveCustomizationOsLock(request.osLock);
  if (!request.targetPath.startsWith("/") || request.assemblyDirectory.length === 0 ||
      request.runnerBundleDirectory.length === 0) throw customizationError("invalid-input");

  const cancellation = new AbortController();
  const isCanceled = (): boolean => cancellation.signal.aborted;
  const abort = (): void => { cancellation.abort(); };
  request.cancellation?.addEventListener("abort", abort, { once: true });
  if (request.cancellation?.aborted === true) abort();
  const signalSource = dependencies.signalSource ?? process;
  const listeners = new Map<NodeJS.Signals, () => void>();
  for (const signal of forwardedSignals) {
    const listener = (): void => { cancellation.abort(); };
    listeners.set(signal, listener);
    signalSource.on(signal, listener);
  }

  const mounted: MountedCustomizationPartition[] = [];
  let mountRoot: PrivateMountRoot | undefined;
  let operationError: ImageCustomizationError | undefined;
  let result: CustomizeWrittenImageResult | undefined;
  let cleanupErrorCount = 0;

  const unmountAll = async (): Promise<void> => {
    for (const partition of [...mounted].reverse()) {
      try {
        await dependencies.mountHost.unmount(partition.mountPath, new AbortController().signal);
        mounted.splice(mounted.indexOf(partition), 1);
      } catch {
        cleanupErrorCount += 1;
      }
    }
  };

  try {
    const partitions = await waitForImagePartitions({
      cancellation: cancellation.signal,
      ...(dependencies.clock === undefined ? {} : { clock: dependencies.clock }),
      inspector: dependencies.partitionInspector,
      osLock,
      ...(dependencies.partitionPollIntervalMs === undefined
        ? {}
        : { pollIntervalMs: dependencies.partitionPollIntervalMs }),
      targetPath: request.targetPath,
      ...(dependencies.partitionTimeoutMs === undefined
        ? {}
        : { timeoutMs: dependencies.partitionTimeoutMs }),
    });
    if (isCanceled()) throw customizationError("canceled");

    try {
      mountRoot = await (dependencies.mountRootFactory ?? new SystemPrivateMountRootFactory()).create();
      for (const partition of partitions) {
        const mountPath = mountPathFor(mountRoot.path, partition);
        await mkdir(mountPath, { mode: 0o700, recursive: true });
        await dependencies.mountHost.mount(partition, mountPath, cancellation.signal);
        mounted.push({ ...partition, mountPath });
        if (isCanceled()) throw customizationError("canceled");
      }
    } catch (error) {
      if (error instanceof ImageCustomizationError) throw error;
      throw sanitizedError("mount-failed", cancellation.signal);
    }

    let adapterResult;
    try {
      adapterResult = await dependencies.adapter.customize({
        assemblyDirectory: request.assemblyDirectory,
        bootstrapSecrets: request.bootstrapSecrets,
        mountedPartitions: mounted,
        osLock,
        runnerBundleDirectory: request.runnerBundleDirectory,
      }, cancellation.signal);
    } catch {
      throw sanitizedError("adapter-failed", cancellation.signal);
    }
    if (isCanceled()) throw customizationError("canceled");
    assertAdapterPostconditions(adapterResult);

    await unmountAll();
    if (cleanupErrorCount > 0) throw cleanupFailure(undefined, cleanupErrorCount);
    if (isCanceled()) throw customizationError("canceled");

    const filesystemChecks: Array<CustomizeWrittenImageResult["filesystemChecks"][number]> = [];
    for (const partition of partitions) {
      try {
        await dependencies.filesystemChecker.check(partition, cancellation.signal);
      } catch {
        throw sanitizedError("filesystem-check-failed", cancellation.signal);
      }
      if (isCanceled()) throw customizationError("canceled");
      filesystemChecks.push({
        filesystem: partition.filesystem,
        role: partition.role,
        status: "passed",
      });
    }
    result = {
      assertions: adapterResult.assertions.map(({ id, path, status }) => ({ id, path, status })),
      assemblyId: adapterResult.assemblyId,
      catalogId: adapterResult.catalogId,
      filesystemChecks,
    };
  } catch (error) {
    operationError = error instanceof ImageCustomizationError
      ? error
      : sanitizedError("adapter-failed", cancellation.signal);
  } finally {
    await unmountAll();
    if (mountRoot !== undefined && mounted.length === 0) {
      try {
        await mountRoot.remove();
      } catch {
        cleanupErrorCount += 1;
      }
    }
    request.cancellation?.removeEventListener("abort", abort);
    for (const [signal, listener] of listeners) signalSource.off(signal, listener);
  }

  if (isCanceled() && operationError === undefined) operationError = customizationError("canceled");
  if (cleanupErrorCount > 0) throw cleanupFailure(operationError, cleanupErrorCount);
  if (operationError !== undefined) throw operationError;
  if (result === undefined) throw customizationError("adapter-failed");
  return result;
};

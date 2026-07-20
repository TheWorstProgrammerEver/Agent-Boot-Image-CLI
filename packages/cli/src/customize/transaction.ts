import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import { RaspberryPiOsCapacityError } from "@agent-boot/os-adapters";

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
  completedPhase?: "check",
): ImageCustomizationError => new ImageCustomizationError("cleanup-failed", {
  cause: new AggregateError([
    ...(operationError === undefined ? [] : [operationError]),
    ...Array.from({ length: count }, () => customizationError("cleanup-failed")),
  ]),
  cleanupOnly: operationError === undefined,
  ...(completedPhase === undefined ? {} : { completedPhase }),
});

const mountPathFor = (root: string, partition: ValidatedImagePartition): string =>
  join(root, partition.role);

const isPassingAdapterAssertion = (value: unknown): boolean => {
  if (typeof value !== "object" || value === null) return false;
  const assertion = value as Record<string, unknown>;
  return typeof assertion.id === "string" && assertion.id.length > 0 &&
    typeof assertion.path === "string" && assertion.path.startsWith("/") &&
    assertion.status === "passed";
};

const assertAdapterPostconditions = (
  result: Awaited<ReturnType<CustomizeWrittenImageDependencies["adapter"]["customize"]>>,
): void => {
  const runtimeResult: unknown = result;
  if (typeof runtimeResult !== "object" || runtimeResult === null ||
      !("assertions" in runtimeResult) || !Array.isArray(runtimeResult.assertions) ||
      runtimeResult.assertions.length === 0 ||
      runtimeResult.assertions.some(assertion => !isPassingAdapterAssertion(assertion))) {
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

  const mountsRequiringCleanup: MountedCustomizationPartition[] = [];
  let mountRoot: PrivateMountRoot | undefined;
  let operationError: ImageCustomizationError | undefined;
  let result: CustomizeWrittenImageResult | undefined;
  let cleanupErrorCount = 0;

  const unmountAll = async (): Promise<void> => {
    for (const partition of [...mountsRequiringCleanup].reverse()) {
      try {
        await dependencies.mountHost.unmount(partition.mountPath, new AbortController().signal);
        mountsRequiringCleanup.splice(mountsRequiringCleanup.indexOf(partition), 1);
      } catch {
        cleanupErrorCount += 1;
      }
    }
  };

  const discoverPartitions = (): Promise<readonly ValidatedImagePartition[]> => waitForImagePartitions({
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

  const mountPartitions = async (
    partitions: readonly ValidatedImagePartition[],
  ): Promise<void> => {
    if (mountRoot === undefined) {
      mountRoot = await (dependencies.mountRootFactory ?? new SystemPrivateMountRootFactory()).create();
    }
    for (const partition of partitions) {
      const mountPath = mountPathFor(mountRoot.path, partition);
      await mkdir(mountPath, { mode: 0o700, recursive: true });
      // A mount may take effect before its command reports failure or cancellation.
      mountsRequiringCleanup.push({ ...partition, mountPath });
      await dependencies.mountHost.mount(partition, mountPath, cancellation.signal);
      if (isCanceled()) throw customizationError("canceled");
    }
  };

  const customizeMounted = async () => dependencies.adapter.customize({
    assemblyDirectory: request.assemblyDirectory,
    bootstrapSecrets: request.bootstrapSecrets,
    mountedPartitions: mountsRequiringCleanup,
    osLock,
    runnerBundleDirectory: request.runnerBundleDirectory,
  }, cancellation.signal);

  try {
    let partitions = await discoverPartitions();
    if (isCanceled()) throw customizationError("canceled");

    try {
      await mountPartitions(partitions);
    } catch (error) {
      if (error instanceof ImageCustomizationError) throw error;
      throw sanitizedError("mount-failed", cancellation.signal);
    }

    let adapterResult;
    try {
      adapterResult = await customizeMounted();
    } catch (error) {
      if (!(error instanceof RaspberryPiOsCapacityError)) {
        throw sanitizedError("adapter-failed", cancellation.signal);
      }
      if (error.role !== "root" || dependencies.capacityProvisioner === undefined) {
        throw sanitizedError("capacity-insufficient", cancellation.signal);
      }
      const rootPartition = partitions.find(partition => partition.role === "root");
      if (rootPartition === undefined) throw customizationError("partition-layout");
      await unmountAll();
      if (cleanupErrorCount > 0) throw cleanupFailure(undefined, cleanupErrorCount);
      if (isCanceled()) throw customizationError("canceled");
      try {
        await dependencies.capacityProvisioner.provision({
          requiredAdditionalBytes: error.details.requiredAdditionalBytes,
          rootPartition,
          targetPath: request.targetPath,
        }, cancellation.signal);
      } catch (provisionError) {
        if (provisionError instanceof ImageCustomizationError) throw provisionError;
        throw sanitizedError("capacity-provision-failed", cancellation.signal);
      }
      partitions = await discoverPartitions();
      if (isCanceled()) throw customizationError("canceled");
      try {
        await mountPartitions(partitions);
      } catch (mountError) {
        if (mountError instanceof ImageCustomizationError) throw mountError;
        throw sanitizedError("mount-failed", cancellation.signal);
      }
      try {
        adapterResult = await customizeMounted();
      } catch (retryError) {
        if (retryError instanceof RaspberryPiOsCapacityError) {
          throw sanitizedError("capacity-insufficient", cancellation.signal);
        }
        throw sanitizedError("adapter-failed", cancellation.signal);
      }
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
    if (mountRoot !== undefined && mountsRequiringCleanup.length === 0) {
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
  if (cleanupErrorCount > 0) {
    throw cleanupFailure(operationError, cleanupErrorCount, result === undefined ? undefined : "check");
  }
  if (operationError !== undefined) throw operationError;
  if (result === undefined) throw customizationError("adapter-failed");
  return result;
};

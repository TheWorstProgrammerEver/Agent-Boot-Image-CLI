import type { OsLock } from "@agent-boot/protocol";

import { customizationError } from "./errors.js";
import type {
  ImagePartitionInspector,
  InspectedImagePartition,
  PartitionWaitClock,
  ValidatedImagePartition,
} from "./model.js";

const abortableSleep = (milliseconds: number, cancellation: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (cancellation.aborted) {
      reject(customizationError("canceled"));
      return;
    }
    const timeout = setTimeout(finish, milliseconds);
    const abort = (): void => {
      clearTimeout(timeout);
      cancellation.removeEventListener("abort", abort);
      reject(customizationError("canceled"));
    };
    function finish(): void {
      cancellation.removeEventListener("abort", abort);
      resolve();
    }
    cancellation.addEventListener("abort", abort, { once: true });
  });

export const systemPartitionWaitClock: PartitionWaitClock = {
  now: () => Date.now(),
  sleep: abortableSleep,
};

const exactLayout = (
  inspected: readonly InspectedImagePartition[],
  osLock: OsLock,
  targetPath: string,
): readonly ValidatedImagePartition[] | undefined => {
  if (inspected.length !== osLock.partitions.length) return undefined;
  const devicePaths = new Set(inspected.map(({ devicePath }) => devicePath));
  if (devicePaths.size !== inspected.length || inspected.some(({ devicePath, parentPath }) =>
    !devicePath.startsWith("/") || devicePath === targetPath || parentPath !== targetPath)) return undefined;

  const used = new Set<number>();
  const validated: ValidatedImagePartition[] = [];
  for (const expected of osLock.partitions) {
    const matching = inspected.flatMap((partition, index) =>
      partition.filesystem === expected.filesystem && partition.label === expected.label && !used.has(index)
        ? [{ index, partition }]
        : []);
    if (matching.length !== 1 || matching[0] === undefined) return undefined;
    used.add(matching[0].index);
    validated.push({
      devicePath: matching[0].partition.devicePath,
      filesystem: expected.filesystem,
      label: expected.label,
      role: expected.role,
    });
  }
  return validated;
};

export interface WaitForImagePartitionsOptions {
  readonly cancellation: AbortSignal;
  readonly clock?: PartitionWaitClock;
  readonly inspector: ImagePartitionInspector;
  readonly osLock: OsLock;
  readonly pollIntervalMs?: number;
  readonly targetPath: string;
  readonly timeoutMs?: number;
}

export const waitForImagePartitions = async (
  options: WaitForImagePartitionsOptions,
): Promise<readonly ValidatedImagePartition[]> => {
  const clock = options.clock ?? systemPartitionWaitClock;
  const pollIntervalMs = options.pollIntervalMs ?? 100;
  const timeoutMs = options.timeoutMs ?? 10_000;
  if (!Number.isSafeInteger(pollIntervalMs) || pollIntervalMs <= 0 ||
      !Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || !options.targetPath.startsWith("/")) {
    throw customizationError("invalid-input");
  }

  const started = clock.now();
  const isCanceled = (): boolean => options.cancellation.aborted;
  let sawPartitions = false;
  let attempts = 0;
  const maximumAttempts = Math.ceil(timeoutMs / pollIntervalMs) + 1;
  for (;;) {
    attempts += 1;
    if (isCanceled()) throw customizationError("canceled");
    let inspected: readonly InspectedImagePartition[] = [];
    try {
      inspected = await options.inspector.inspect(options.targetPath, options.cancellation);
    } catch {
      if (isCanceled()) throw customizationError("canceled");
    }
    sawPartitions ||= inspected.length > 0;
    const validated = exactLayout(inspected, options.osLock, options.targetPath);
    if (validated !== undefined) return validated;

    const elapsed = clock.now() - started;
    if (!Number.isFinite(elapsed) || elapsed >= timeoutMs || attempts >= maximumAttempts) {
      throw customizationError(sawPartitions ? "partition-layout" : "partition-timeout");
    }
    await clock.sleep(Math.min(pollIntervalMs, timeoutMs - elapsed), options.cancellation);
  }
};

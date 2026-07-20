import { DriveGuardrailError } from "../drives/index.js";
import { ImageCustomizationError } from "../customize/index.js";
import { ImageWriteError } from "../imaging/index.js";
import { ImageWorkflowError, type ImageWorkflowPhase } from "./errors.js";

const destructivePhases = new Set<ImageWorkflowPhase>(["lock", "recheck", "write", "verify"]);

const transactionCleanupError = (
  error: unknown,
): error is ImageWriteError | ImageCustomizationError =>
  (error instanceof ImageWriteError || error instanceof ImageCustomizationError) &&
  error.code === "cleanup-failed";

const primaryCause = (error: unknown): unknown => {
  if (!transactionCleanupError(error)) return error;
  if (error.cleanupOnly) return undefined;
  if (!(error.cause instanceof AggregateError)) return error;
  return primaryCause(error.cause.errors[0]);
};

const writeFailurePhase = (primary: unknown, current: ImageWorkflowPhase): ImageWorkflowPhase => {
  if (!(primary instanceof ImageWriteError)) return current;
  if (primary.code === "lock-contention" || primary.code === "lock-failed") return "lock";
  if (primary.code === "unmount-failed") return "recheck";
  if (["read-back-mismatch", "short-read"].includes(primary.code)) return "verify";
  return "write";
};

const customizationFailurePhase = (primary: unknown): ImageWorkflowPhase => {
  return primary instanceof ImageCustomizationError && primary.code === "filesystem-check-failed"
    ? "check"
    : "customize";
};

export const phaseForFailure = (
  error: unknown,
  current: ImageWorkflowPhase,
): ImageWorkflowPhase => {
  if (error instanceof ImageWorkflowError) return error.phase;
  const primary = primaryCause(error);
  if (primary === undefined) return "cleanup";
  if (primary instanceof ImageWorkflowError) return primary.phase;
  if (primary instanceof ImageWriteError || isDestructivePhase(current)) {
    return writeFailurePhase(primary, current);
  }
  if (primary instanceof ImageCustomizationError || current === "customize" || current === "check") {
    return customizationFailurePhase(primary);
  }
  if (primary instanceof DriveGuardrailError && primary.code === "confirmation-rejected") {
    return "confirmation";
  }
  return current;
};

export const cleanupFailedFor = (error: unknown): boolean => {
  const pending: unknown[] = [error];
  const seen = new Set<unknown>();
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined || seen.has(current)) continue;
    seen.add(current);
    if (current instanceof ImageWorkflowError && current.cleanupFailed) return true;
    if (transactionCleanupError(current)) return true;
    if (current instanceof AggregateError) pending.push(...current.errors as unknown[]);
    if (current instanceof Error && current.cause !== undefined) pending.push(current.cause);
  }
  return false;
};

export const completedRecoveryFor = (
  error: unknown,
): "complete" | "target-verified-needs-customization" | undefined => {
  let verified = false;
  const pending: unknown[] = [error];
  const seen = new Set<unknown>();
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined || seen.has(current)) continue;
    seen.add(current);
    if (current instanceof ImageCustomizationError && current.completedPhase === "check") {
      return "complete";
    }
    if (current instanceof ImageWriteError && current.completedPhase === "verify") verified = true;
    if (current instanceof AggregateError) pending.push(...current.errors as unknown[]);
    if (current instanceof Error && current.cause !== undefined) pending.push(current.cause);
  }
  return verified ? "target-verified-needs-customization" : undefined;
};

const isDestructivePhase = (phase: ImageWorkflowPhase): boolean =>
  destructivePhases.has(phase);

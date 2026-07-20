import { DriveGuardrailError } from "../drives/index.js";
import { ImageCustomizationError } from "../customize/index.js";
import { ImageWriteError } from "../imaging/index.js";
import { ImageWorkflowError, type ImageWorkflowPhase } from "./errors.js";

const destructivePhases = new Set<ImageWorkflowPhase>(["lock", "recheck", "write", "verify"]);

const primaryCause = (error: Error): unknown => {
  if (
    (error instanceof ImageWriteError || error instanceof ImageCustomizationError) &&
    error.code === "cleanup-failed" && error.cause instanceof AggregateError
  ) return error.cause.errors[0];
  return error;
};

const writeFailurePhase = (error: unknown, current: ImageWorkflowPhase): ImageWorkflowPhase => {
  const primary = error instanceof Error ? primaryCause(error) : error;
  if (!(primary instanceof ImageWriteError)) return current;
  if (primary.code === "lock-contention" || primary.code === "lock-failed") return "lock";
  if (primary.code === "unmount-failed") return "recheck";
  if (["read-back-mismatch", "short-read"].includes(primary.code)) return "verify";
  return "write";
};

const customizationFailurePhase = (error: unknown): ImageWorkflowPhase => {
  const primary = error instanceof Error ? primaryCause(error) : error;
  return primary instanceof ImageCustomizationError && primary.code === "filesystem-check-failed"
    ? "check"
    : "customize";
};

export const phaseForFailure = (
  error: unknown,
  current: ImageWorkflowPhase,
): ImageWorkflowPhase => {
  if (error instanceof ImageWorkflowError) return error.phase;
  if (isDestructivePhase(current)) return writeFailurePhase(error, current);
  if (current === "customize" || current === "check") return customizationFailurePhase(error);
  if (error instanceof DriveGuardrailError && error.code === "confirmation-rejected") {
    return "confirmation";
  }
  return current;
};

const isDestructivePhase = (phase: ImageWorkflowPhase): boolean =>
  destructivePhases.has(phase);

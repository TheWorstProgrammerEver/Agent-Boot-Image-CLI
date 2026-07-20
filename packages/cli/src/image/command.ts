import { ImageWorkflowError } from "./errors.js";
import { IMAGE_USAGE, parseImageArguments } from "./arguments.js";
import type { ImageWorkflowDependencies } from "./model.js";
import { runImageWorkflow } from "./orchestrator.js";
import type { CommandIo, CreateAgentExitCode } from "../validate-command.js";

export const IMAGE_EXIT_CODE = {
  canceled: 130,
  cleanupFailure: 13,
  customizationFailure: 12,
  preparationFailure: 9,
  preflightFailure: 10,
  writeFailure: 11,
} as const;

const exitCodeFor = (error: ImageWorkflowError): CreateAgentExitCode => {
  if (error.cleanupFailed) return IMAGE_EXIT_CODE.cleanupFailure;
  if (error.canceled) return IMAGE_EXIT_CODE.canceled;
  if (error.phase === "confirmation" || error.phase === "preflight") {
    return IMAGE_EXIT_CODE.preflightFailure;
  }
  if (["lock", "recheck", "write", "verify"].includes(error.phase)) {
    return IMAGE_EXIT_CODE.writeFailure;
  }
  if (error.phase === "customize" || error.phase === "check") {
    return IMAGE_EXIT_CODE.customizationFailure;
  }
  return IMAGE_EXIT_CODE.preparationFailure;
};

export const runImageCommand = async (
  arguments_: readonly string[],
  io: CommandIo,
  dependencies: ImageWorkflowDependencies,
): Promise<CreateAgentExitCode> => {
  const request = parseImageArguments(arguments_);
  if (request === undefined) {
    io.stderr(IMAGE_USAGE);
    return 64;
  }

  try {
    const result = await runImageWorkflow(request, io, dependencies);
    if (result.dryRun) {
      io.stdout(
        `Dry-run complete: assembly ${result.assemblyId}; OS lock ${result.catalogId}; ` +
        "target and real adapters were not accessed.",
      );
      return 0;
    }
    io.stdout(
      `Image complete: assembly ${result.assemblyId}; OS lock ${result.catalogId}; ` +
      `${String(result.targetBytesVerified)} target bytes read-back verified; ` +
      `${String(result.filesystemCheckCount)} filesystem checks passed.`,
    );
    return 0;
  } catch (error) {
    const failure = error instanceof ImageWorkflowError
      ? error
      : new ImageWorkflowError("preparation", "target-unchanged", { cause: error });
    const cleanup = failure.cleanupFailed
      ? " Temporary workspace cleanup failed; recovery cleanup is required."
      : "";
    io.stderr(
      `Image failed during ${failure.phase}; recovery state: ${failure.recovery}.${cleanup}`,
    );
    return exitCodeFor(failure);
  }
};

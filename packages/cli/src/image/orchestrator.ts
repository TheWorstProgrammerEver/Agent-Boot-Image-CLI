import { prepareImageTargetPlan } from "../drives/index.js";
import type { ImageWriteProgress } from "../imaging/index.js";
import {
  ImageWorkflowError,
  type ImageRecoveryState,
  type ImageWorkflowPhase,
} from "./errors.js";
import type {
  ImageCommandRequest,
  ImageWorkflowDependencies,
  ImageWorkflowResult,
} from "./model.js";
import type { CommandIo } from "../validate-command.js";
import { cleanupFailedFor, completedRecoveryFor, phaseForFailure } from "./failure.js";
import { printAssemblyPlan } from "./plan.js";

const forwardedSignals = ["SIGHUP", "SIGINT", "SIGTERM"] as const;

const checkCanceled = (cancellation: AbortSignal): void => {
  if (cancellation.aborted) throw new Error("Image workflow canceled.");
};

const wipeSecrets = (secrets: ReadonlyMap<string, Uint8Array> | undefined): void => {
  for (const value of secrets?.values() ?? []) value.fill(0);
};

const latestRecovery = (
  current: ImageRecoveryState,
  completed: "complete" | "target-verified-needs-customization" | undefined,
): ImageRecoveryState => completed === "complete" || current === "complete"
  ? "complete"
  : completed ?? current;

export const runImageWorkflow = async (
  request: ImageCommandRequest,
  io: CommandIo,
  dependencies: ImageWorkflowDependencies,
): Promise<ImageWorkflowResult> => {
  const cancellation = new AbortController();
  const abort = (): void => { cancellation.abort(); };
  const signalSource = dependencies.signalSource ?? process;
  for (const signal of forwardedSignals) signalSource.on(signal, abort);

  let activePhase: ImageWorkflowPhase = "validation";
  let recovery: ImageRecoveryState = "target-unchanged";
  let bootstrapSecrets: Map<string, Uint8Array> | undefined;
  let workspace: Awaited<ReturnType<ImageWorkflowDependencies["createWorkspace"]>> | undefined;
  let operationError: ImageWorkflowError | undefined;
  let result: ImageWorkflowResult | undefined;
  const cleanupErrors: unknown[] = [];

  try {
    const loaded = await dependencies.loadDefinition(request.definitionPath);
    checkCanceled(cancellation.signal);

    activePhase = "os-resolution";
    const osLock = dependencies.resolveOsLock(loaded.definition);
    checkCanceled(cancellation.signal);

    activePhase = "validation";
    const runnerArtifacts = await dependencies.readRunnerArtifacts({
      entrypointPath: request.runnerEntrypointPath,
      runtimePath: request.runnerRuntimePath,
    });
    await dependencies.verifyRunnerBundle(request.runnerBundleDirectory);
    checkCanceled(cancellation.signal);

    activePhase = "synthesis";
    const assembly = await dependencies.synthesize(loaded.definition, osLock, runnerArtifacts);
    checkCanceled(cancellation.signal);

    if (request.dryRun) {
      printAssemblyPlan(io, {
        assemblyId: assembly.assemblyId,
        catalogId: osLock.catalogId,
        dryRun: true,
      });
      result = {
        assemblyId: assembly.assemblyId,
        catalogId: osLock.catalogId,
        dryRun: true,
        filesystemCheckCount: 0,
      };
    } else {
      activePhase = "validation";
      const loadedBootstrapSecrets = await dependencies.loadBootstrapSecrets(loaded.definition);
      bootstrapSecrets = loadedBootstrapSecrets;
      checkCanceled(cancellation.signal);

      activePhase = "artifact-acquisition";
      const artifact = await dependencies.acquireArtifact(
        osLock,
        request.cacheDirectory,
        cancellation.signal,
      );
      checkCanceled(cancellation.signal);

      activePhase = "preparation";
      const preparedWorkspace = await dependencies.createWorkspace();
      workspace = preparedWorkspace;
      await dependencies.publishAssembly(preparedWorkspace, assembly);
      const preparedSource = await dependencies.prepareImageSource(
        artifact,
        preparedWorkspace,
        cancellation.signal,
      );
      checkCanceled(cancellation.signal);

      activePhase = "preflight";
      const targetPlan = await prepareImageTargetPlan({
        constraints: {
          expectedModel: request.expectedModel,
          expectedRemovable: true,
          expectedSerial: request.expectedSerial,
          expectedTransport: request.expectedTransport,
          maxSizeBytes: request.maxSizeBytes,
        },
        stableTarget: request.stableTarget,
      }, dependencies.driveInspector);
      checkCanceled(cancellation.signal);

      printAssemblyPlan(io, {
        artifactSha256: artifact.sha256,
        assemblyId: assembly.assemblyId,
        catalogId: osLock.catalogId,
        dryRun: false,
      });
      activePhase = "confirmation";
      const confirmedPlan = await dependencies.confirmTarget(
        targetPlan,
        request,
        io,
        cancellation.signal,
      );
      checkCanceled(cancellation.signal);

      activePhase = "lock";
      const writeResult = await dependencies.writeImage({
        afterVerify: async ({ cancellation: transactionCancellation, target }) => {
          recovery = "target-verified-needs-customization";
          activePhase = "customize";
          const customization = await dependencies.customizeImage({
            assemblyDirectory: preparedWorkspace.assemblyDirectory,
            bootstrapSecrets: loadedBootstrapSecrets,
            cancellation: transactionCancellation,
            definition: loaded.definition,
            osLock,
            runnerBundleDirectory: request.runnerBundleDirectory,
            targetPath: target.resolvedTarget,
          });
          recovery = "complete";
          return customization;
        },
        cancellation: cancellation.signal,
        expectedByteLength: artifact.imageByteLength,
        lockDirectory: request.lockDirectory,
        onProgress: (progress: ImageWriteProgress) => {
          activePhase = progress.phase === "unmount" ? "recheck" : progress.phase;
        },
        plan: confirmedPlan,
        source: preparedSource.source,
      });
      checkCanceled(cancellation.signal);

      result = {
        assemblyId: assembly.assemblyId,
        catalogId: osLock.catalogId,
        dryRun: false,
        filesystemCheckCount: writeResult.afterVerifyResult.filesystemChecks.length,
        osArtifactSha256: artifact.sha256,
        targetBytesVerified: writeResult.bytesVerified,
        targetVerification: "read-back-passed",
      };
    }
  } catch (error) {
    const failurePhase = phaseForFailure(error, activePhase);
    const completedRecovery = completedRecoveryFor(error);
    const lastRecovery = latestRecovery(recovery, completedRecovery);
    const failedRecovery = lastRecovery === "target-unchanged" &&
        (failurePhase === "write" || failurePhase === "verify")
      ? "target-incomplete"
      : lastRecovery;
    const cleanupFailed = cleanupFailedFor(error);
    operationError = cancellation.signal.aborted
      ? new ImageWorkflowError(failurePhase, failedRecovery, {
          canceled: true,
          cause: error,
          cleanupFailed,
        })
      : error instanceof ImageWorkflowError
        ? error
        : new ImageWorkflowError(failurePhase, failedRecovery, {
            cause: error,
            cleanupFailed,
          });
  } finally {
    wipeSecrets(bootstrapSecrets);
    if (workspace !== undefined) {
      try {
        await workspace.remove();
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    for (const signal of forwardedSignals) signalSource.off(signal, abort);
  }

  if (cleanupErrors.length > 0) {
    const phase = operationError?.phase ?? "cleanup";
    const aggregate = new AggregateError([
      ...(operationError === undefined ? [] : [operationError]),
      ...cleanupErrors,
    ]);
    throw new ImageWorkflowError(phase, operationError?.recovery ?? recovery, {
      canceled: operationError?.canceled ?? false,
      cause: aggregate,
      cleanupFailed: true,
    });
  }
  if (operationError !== undefined) throw operationError;
  if (result === undefined) throw new ImageWorkflowError("cleanup", recovery);
  return result;
};

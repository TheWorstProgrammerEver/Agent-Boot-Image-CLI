import { writeAssemblyAtomically } from "@agent-boot/assembly";
import { LinuxDriveInspector } from "@agent-boot/os-linux";
import {
  OpenSslPasswordHasher,
  PosixImageOwnership,
} from "@agent-boot/os-adapters";
import { NodeSpawnAdapter } from "@agent-boot/process";
import { verifyRunnerBundle } from "@agent-boot/runner-bundle";
import { synthesizeAssembly } from "@agent-boot/synth";
import { createInterface } from "node:readline/promises";
import type { Readable, Writable } from "node:stream";

import {
  CommandImageFilesystemChecker,
  CommandImageMountHost,
  CommandImagePartitionInspector,
  RaspberryPiOsTrixieCustomizationAdapter,
  customizeWrittenImage,
} from "../customize/index.js";
import { confirmImageTargetPlan } from "../drives/index.js";
import { acquireOsArtifact } from "../images/index.js";
import {
  CommandDescendantUnmounter,
  ExactRawImageWriter,
  FileDeviceOperationLocker,
  FullReadBackVerifier,
  writeImageTransaction,
} from "../imaging/index.js";
import { readRegularInputFile } from "../input-file.js";
import { loadTrustedDefinition } from "../trusted-definition-loader.js";
import type { ImageWorkflowDependencies } from "./model.js";
import { resolveDefinitionOsLock } from "./os-lock.js";
import { XzRawImagePreparer } from "./raw-image.js";
import { loadBootstrapSecrets } from "./secrets.js";
import { createSystemImageWorkspace } from "./workspace.js";

const unavailable = (): Promise<never> =>
  Promise.reject(new Error("Dry-run crossed a live adapter boundary."));

export const requestImageTargetAcknowledgement = async (
  prompt: string,
  cancellation: AbortSignal,
  input: Readable = process.stdin,
  output: Writable = process.stdout,
): Promise<string> => {
  const readline = createInterface({ input, output });
  try {
    return await readline.question(`${prompt} `, { signal: cancellation });
  } catch (error) {
    if (cancellation.aborted) {
      throw new Error("Image target confirmation canceled.", { cause: error });
    }
    throw error;
  } finally {
    readline.close();
  }
};

const commonSafeDependencies = (): Pick<ImageWorkflowDependencies,
  | "loadDefinition"
  | "readRunnerArtifacts"
  | "resolveOsLock"
  | "synthesize"
  | "verifyRunnerBundle"
> => ({
  loadDefinition: loadTrustedDefinition,
  readRunnerArtifacts: async ({ entrypointPath, runtimePath }) => ({
    entrypoint: await readRegularInputFile(entrypointPath),
    runtime: await readRegularInputFile(runtimePath),
  }),
  resolveOsLock: resolveDefinitionOsLock,
  synthesize: async (definition, osLock, runnerArtifacts) =>
    synthesizeAssembly(definition, { osLock, runnerArtifacts }),
  verifyRunnerBundle: async directory => { await verifyRunnerBundle(directory); },
});

export const createDryRunImageWorkflowDependencies = (): ImageWorkflowDependencies => ({
  ...commonSafeDependencies(),
  acquireArtifact: unavailable,
  confirmTarget: unavailable,
  createWorkspace: unavailable,
  customizeImage: unavailable,
  driveInspector: { inspect: unavailable },
  loadBootstrapSecrets: unavailable,
  prepareImageSource: unavailable,
  publishAssembly: unavailable,
  writeImage: unavailable,
});

export const createLiveImageWorkflowDependencies = (): ImageWorkflowDependencies => {
  const commands = new NodeSpawnAdapter();
  const rawImages = new XzRawImagePreparer(commands);
  return {
    ...commonSafeDependencies(),
    acquireArtifact: async (osLock, cacheDirectory, cancellation) => {
      cancellation.throwIfAborted();
      const artifact = await acquireOsArtifact(osLock, {
        cacheDirectory,
        commandHost: commands,
        cancellation,
      });
      cancellation.throwIfAborted();
      return artifact;
    },
    confirmTarget: async (plan, request, io, cancellation) => confirmImageTargetPlan(plan, {
      acknowledgement: request.yes
        ? { yes: true }
        : {
            request: prompt => requestImageTargetAcknowledgement(prompt, cancellation),
            yes: false,
          },
      writeLine: io.stdout,
    }),
    createWorkspace: createSystemImageWorkspace,
    customizeImage: async input => {
      const username = input.definition.account.username;
      return customizeWrittenImage({
        assemblyDirectory: input.assemblyDirectory,
        bootstrapSecrets: input.bootstrapSecrets,
        cancellation: input.cancellation,
        osLock: input.osLock,
        runnerBundleDirectory: input.runnerBundleDirectory,
        targetPath: input.targetPath,
      }, {
        adapter: new RaspberryPiOsTrixieCustomizationAdapter({
          account: {
            gid: 1000,
            group: username,
            homeDirectory: `/home/${username}`,
            uid: 1000,
            username,
            workingDirectory: `/home/${username}/workspace`,
          },
          ownership: new PosixImageOwnership(),
          passwordHasher: new OpenSslPasswordHasher({ commandHost: commands }),
        }),
        filesystemChecker: new CommandImageFilesystemChecker(commands),
        mountHost: new CommandImageMountHost(commands),
        partitionInspector: new CommandImagePartitionInspector(commands),
      });
    },
    driveInspector: new LinuxDriveInspector(commands),
    loadBootstrapSecrets,
    prepareImageSource: (artifact, workspace, cancellation) =>
      rawImages.prepare(artifact, workspace, cancellation),
    publishAssembly: async (workspace, assembly) => {
      await writeAssemblyAtomically(workspace.assemblyDirectory, assembly.files);
    },
    signalSource: process,
    writeImage: async input => writeImageTransaction({
      afterVerify: input.afterVerify,
      cancellation: input.cancellation,
      expectedByteLength: input.expectedByteLength,
      onProgress: input.onProgress,
      plan: input.plan,
      source: input.source,
    }, {
      inspector: new LinuxDriveInspector(commands),
      locker: new FileDeviceOperationLocker({ lockDirectory: input.lockDirectory }),
      unmounter: new CommandDescendantUnmounter(commands),
      verifier: new FullReadBackVerifier(),
      writer: new ExactRawImageWriter(),
    }),
  };
};

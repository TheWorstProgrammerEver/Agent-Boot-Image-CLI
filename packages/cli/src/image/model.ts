import type { AgentDefinition } from "@agent-boot/definition";
import type { DriveInspector } from "@agent-boot/os-linux";
import type { OsLock } from "@agent-boot/protocol";
import type { SynthesizedAssembly } from "@agent-boot/synth";

import type { CommandIo } from "../validate-command.js";
import type { ConfirmedImageTargetPlan, ImageTargetPlan } from "../drives/index.js";
import type { AcquiredOsArtifact } from "../images/index.js";
import type {
  ImageWriteProgress,
  RepeatableImageSource,
} from "../imaging/index.js";

export interface ImageCommandRequest {
  readonly cacheDirectory: string;
  readonly definitionPath: string;
  readonly dryRun: boolean;
  readonly expectedModel: string;
  readonly expectedSerial: string;
  readonly expectedTransport: string;
  readonly lockDirectory: string;
  readonly maxSizeBytes: number;
  readonly runnerBundleDirectory: string;
  readonly runnerEntrypointPath: string;
  readonly runnerRuntimePath: string;
  readonly stableTarget: string;
  readonly yes: boolean;
}

export interface ImageWorkspace {
  readonly assemblyDirectory: string;
  readonly path: string;
  remove(): Promise<void>;
}

export interface PreparedImageSource {
  readonly source: RepeatableImageSource;
}

export interface ImageWorkflowResult {
  readonly assemblyId: string;
  readonly catalogId: string;
  readonly dryRun: boolean;
  readonly filesystemCheckCount: number;
  readonly osArtifactSha256?: string;
  readonly targetBytesVerified?: number;
  readonly targetVerification?: "read-back-passed";
}

export interface ImageWorkflowDependencies {
  readonly acquireArtifact: (
    osLock: OsLock,
    cacheDirectory: string,
    cancellation: AbortSignal,
  ) => Promise<AcquiredOsArtifact>;
  readonly confirmTarget: (
    plan: ImageTargetPlan,
    request: ImageCommandRequest,
    io: CommandIo,
  ) => Promise<ConfirmedImageTargetPlan>;
  readonly createWorkspace: () => Promise<ImageWorkspace>;
  readonly customizeImage: (input: {
    readonly assemblyDirectory: string;
    readonly bootstrapSecrets: ReadonlyMap<string, Uint8Array>;
    readonly cancellation: AbortSignal;
    readonly definition: AgentDefinition;
    readonly osLock: OsLock;
    readonly runnerBundleDirectory: string;
    readonly targetPath: string;
  }) => Promise<{ readonly filesystemChecks: readonly unknown[] }>;
  readonly driveInspector: DriveInspector;
  readonly loadBootstrapSecrets: (
    definition: AgentDefinition,
  ) => Promise<Map<string, Uint8Array>>;
  readonly loadDefinition: (path: string) => Promise<{
    readonly definition: AgentDefinition;
  }>;
  readonly prepareImageSource: (
    artifact: AcquiredOsArtifact,
    workspace: ImageWorkspace,
    cancellation: AbortSignal,
  ) => Promise<PreparedImageSource>;
  readonly publishAssembly: (
    workspace: ImageWorkspace,
    assembly: SynthesizedAssembly,
  ) => Promise<void>;
  readonly readRunnerArtifacts: (input: {
    readonly entrypointPath: string;
    readonly runtimePath: string;
  }) => Promise<{ readonly entrypoint: Uint8Array; readonly runtime: Uint8Array }>;
  readonly resolveOsLock: (definition: AgentDefinition) => OsLock;
  readonly signalSource?: {
    on(signal: NodeJS.Signals, listener: () => void): unknown;
    off(signal: NodeJS.Signals, listener: () => void): unknown;
  };
  readonly synthesize: (
    definition: AgentDefinition,
    osLock: OsLock,
    runnerArtifacts: { readonly entrypoint: Uint8Array; readonly runtime: Uint8Array },
  ) => Promise<SynthesizedAssembly>;
  readonly verifyRunnerBundle: (directory: string) => Promise<void>;
  readonly writeImage: (input: {
    readonly cancellation: AbortSignal;
    readonly expectedByteLength: number;
    readonly lockDirectory: string;
    readonly onProgress: (progress: ImageWriteProgress) => void;
    readonly plan: ConfirmedImageTargetPlan;
    readonly source: RepeatableImageSource;
  }) => Promise<{
    readonly bytesVerified: number;
    readonly target: { readonly resolvedTarget: string };
  }>;
}

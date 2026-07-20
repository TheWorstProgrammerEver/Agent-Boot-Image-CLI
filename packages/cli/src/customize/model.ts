import type { SignalSource } from "@agent-boot/process";
import type { OsLock } from "@agent-boot/protocol";
import type { RaspberryPiOsCustomizationResult } from "@agent-boot/os-adapters";

export interface InspectedImagePartition {
  readonly devicePath: string;
  readonly filesystem?: string;
  readonly label?: string;
  readonly parentPath: string;
}

export interface ValidatedImagePartition {
  readonly devicePath: string;
  readonly filesystem: string;
  readonly label: string;
  readonly role: string;
}

export interface ImagePartitionInspector {
  inspect(targetPath: string, cancellation: AbortSignal): Promise<readonly InspectedImagePartition[]>;
}

export interface ImageMountHost {
  mount(partition: ValidatedImagePartition, mountPath: string, cancellation: AbortSignal): Promise<void>;
  unmount(mountPath: string, cancellation: AbortSignal): Promise<void>;
}

export interface ImageFilesystemChecker {
  check(partition: ValidatedImagePartition, cancellation: AbortSignal): Promise<void>;
}

export interface ImageCapacityProvisionRequest {
  readonly requiredAdditionalBytes: bigint;
  readonly rootPartition: ValidatedImagePartition;
  readonly targetPath: string;
}

export interface ImageCapacityProvisioner {
  provision(request: ImageCapacityProvisionRequest, cancellation: AbortSignal): Promise<void>;
}

export interface PrivateMountRoot {
  readonly path: string;
  remove(): Promise<void>;
}

export interface PrivateMountRootFactory {
  create(): Promise<PrivateMountRoot>;
}

export interface PartitionWaitClock {
  now(): number;
  sleep(milliseconds: number, cancellation: AbortSignal): Promise<void>;
}

export interface ImageCustomizationAdapterRequest {
  readonly assemblyDirectory: string;
  readonly bootstrapSecrets: ReadonlyMap<string, Uint8Array>;
  readonly mountedPartitions: readonly MountedCustomizationPartition[];
  readonly osLock: OsLock;
  readonly runnerBundleDirectory: string;
}

export interface MountedCustomizationPartition extends ValidatedImagePartition {
  readonly mountPath: string;
}

export interface ImageCustomizationAdapter {
  customize(
    request: ImageCustomizationAdapterRequest,
    cancellation: AbortSignal,
  ): Promise<RaspberryPiOsCustomizationResult>;
}

export interface CustomizeWrittenImageRequest {
  readonly assemblyDirectory: string;
  readonly bootstrapSecrets: ReadonlyMap<string, Uint8Array>;
  readonly cancellation?: AbortSignal;
  readonly osLock: unknown;
  readonly runnerBundleDirectory: string;
  readonly targetPath: string;
}

export interface CustomizeWrittenImageDependencies {
  readonly adapter: ImageCustomizationAdapter;
  readonly capacityProvisioner?: ImageCapacityProvisioner;
  readonly clock?: PartitionWaitClock;
  readonly filesystemChecker: ImageFilesystemChecker;
  readonly mountHost: ImageMountHost;
  readonly mountRootFactory?: PrivateMountRootFactory;
  readonly partitionInspector: ImagePartitionInspector;
  readonly partitionPollIntervalMs?: number;
  readonly partitionTimeoutMs?: number;
  readonly signalSource?: SignalSource;
}

export interface CustomizeWrittenImageResult extends RaspberryPiOsCustomizationResult {
  readonly filesystemChecks: readonly {
    readonly filesystem: string;
    readonly role: string;
    readonly status: "passed";
  }[];
}

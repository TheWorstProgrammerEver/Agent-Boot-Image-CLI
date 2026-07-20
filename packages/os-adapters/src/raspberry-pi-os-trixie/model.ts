import type { SpawnHost } from "@agent-boot/process";
import type { RunnerServiceAccount } from "@agent-boot/runner-bundle";

export interface MountedImagePartition {
  readonly filesystem: string;
  readonly label: string;
  readonly metadata: ImageFilesystemMetadata;
  readonly mountPath: string;
  readonly role: string;
}

export interface MountedPartitionDiscovery {
  discover(): Promise<readonly MountedImagePartition[]>;
}

export interface ImageIdentity {
  readonly gid: number;
  readonly uid: number;
}

export type ImageFilesystemMetadata =
  | { readonly kind: "per-entry" }
  | {
      readonly directoryMode: number;
      readonly fileMode: number;
      readonly identity: ImageIdentity;
      readonly kind: "uniform";
    };

export interface ImageOwnership {
  inspect(path: string, symbolicLink?: boolean): Promise<ImageIdentity>;
  set(path: string, identity: ImageIdentity, symbolicLink?: boolean): Promise<void>;
}

export interface ImagePlanCapacity {
  readonly requiredBlocks: bigint;
  readonly requiredInodes: bigint;
}

export interface MountedFilesystemCapacity {
  readonly availableBlocks: bigint;
  readonly blockSize: bigint;
  readonly freeInodes: bigint;
  readonly totalInodes: bigint;
}

export interface MountedFilesystemCapacityInspector {
  inspect(path: string): Promise<MountedFilesystemCapacity>;
}

export interface RaspberryPiAccount extends RunnerServiceAccount, ImageIdentity {}

export interface PasswordHasher {
  hash(password: Uint8Array, existingHash?: string): Promise<string>;
}

export interface PostCustomizationAssertion {
  readonly id: string;
  readonly path: string;
  readonly status: "passed";
}

export interface RaspberryPiOsCustomizationOptions {
  readonly account: RaspberryPiAccount;
  readonly assemblyDirectory: string;
  readonly bootstrapSecrets: ReadonlyMap<string, Uint8Array>;
  readonly capacityInspector?: MountedFilesystemCapacityInspector;
  readonly osLock: unknown;
  readonly ownership: ImageOwnership;
  readonly partitionDiscovery: MountedPartitionDiscovery;
  readonly passwordHasher?: PasswordHasher;
  readonly runnerBundleDirectory: string;
}

export interface RaspberryPiOsCustomizationResult {
  readonly assertions: readonly PostCustomizationAssertion[];
  readonly assemblyId: string;
  readonly catalogId: string;
}

export interface OpenSslPasswordHasherOptions {
  readonly commandHost: SpawnHost;
  readonly timeoutMs?: number;
}

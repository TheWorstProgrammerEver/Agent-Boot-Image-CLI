import type { SpawnHost } from "@agent-boot/process";
import type { RunnerServiceAccount } from "@agent-boot/runner-bundle";

export interface MountedImagePartition {
  readonly filesystem: string;
  readonly label: string;
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

export interface ImageOwnership {
  inspect(path: string, symbolicLink?: boolean): Promise<ImageIdentity>;
  set(path: string, identity: ImageIdentity, symbolicLink?: boolean): Promise<void>;
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

import {
  customizeRaspberryPiOsTrixie,
  type ImageOwnership,
  type PasswordHasher,
  type RaspberryPiAccount,
  type RaspberryPiOsCustomizationResult,
} from "@agent-boot/os-adapters/raspberry-pi-os-trixie";

import type {
  ImageCustomizationAdapter,
  ImageCustomizationAdapterRequest,
} from "./model.js";

export interface RaspberryPiOsTrixieCustomizationAdapterOptions {
  readonly account: RaspberryPiAccount;
  readonly ownership: ImageOwnership;
  readonly passwordHasher?: PasswordHasher;
}

export class RaspberryPiOsTrixieCustomizationAdapter implements ImageCustomizationAdapter {
  readonly #options: RaspberryPiOsTrixieCustomizationAdapterOptions;

  constructor(options: RaspberryPiOsTrixieCustomizationAdapterOptions) {
    this.#options = options;
  }

  async customize(
    request: ImageCustomizationAdapterRequest,
    cancellation: AbortSignal,
  ): Promise<RaspberryPiOsCustomizationResult> {
    const isCanceled = (): boolean => cancellation.aborted;
    if (isCanceled()) throw new Error("canceled");
    const result = await customizeRaspberryPiOsTrixie({
      ...this.#options,
      assemblyDirectory: request.assemblyDirectory,
      bootstrapSecrets: request.bootstrapSecrets,
      osLock: request.osLock,
      partitionDiscovery: { discover: () => Promise.resolve(request.mountedPartitions.map(partition => ({
        filesystem: partition.filesystem,
        label: partition.label,
        metadata: partition.role === "boot"
          ? {
              directoryMode: 0o700,
              fileMode: 0o600,
              identity: { gid: 0, uid: 0 },
              kind: "uniform" as const,
            }
          : { kind: "per-entry" as const },
        mountPath: partition.mountPath,
        role: partition.role,
      }))) },
      runnerBundleDirectory: request.runnerBundleDirectory,
    });
    if (isCanceled()) throw new Error("canceled");
    return result;
  }
}

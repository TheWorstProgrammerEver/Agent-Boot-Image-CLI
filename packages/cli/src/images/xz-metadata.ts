import type { BoundedExecHost } from "@agent-boot/process";

import { ArtifactAcquisitionError } from "./errors.js";
import type { ArtifactImageMetadata, ArtifactMetadataInspector } from "./model.js";

const positiveInteger = (value: string | undefined): number | undefined => {
  if (value === undefined || !/^\d+$/u.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
};

export class XzMetadataInspector implements ArtifactMetadataInspector {
  readonly #commands: BoundedExecHost;

  constructor(commands: BoundedExecHost) {
    this.#commands = commands;
  }

  async inspect(path: string, compressedByteLength: number): Promise<ArtifactImageMetadata> {
    try {
      const { stdout } = await this.#commands.exec({
        arguments: ["--robot", "--list", "--", path],
        executable: "xz",
        label: "inspect verified OS artifact",
        maxOutputBytes: 64 * 1_024,
        sensitiveValues: [path],
        timeoutMs: 30_000,
      });
      const fields = stdout.split("\n").find(line => line.startsWith("file\t"))?.split("\t");
      const listedCompressedBytes = positiveInteger(fields?.[3]);
      const imageByteLength = positiveInteger(fields?.[4]);
      if (listedCompressedBytes !== compressedByteLength || imageByteLength === undefined) {
        throw new Error("invalid metadata");
      }
      return {
        compressedByteLength,
        compressionFormat: "xz",
        imageByteLength,
        imageFormat: "raw",
      };
    } catch {
      throw new ArtifactAcquisitionError("metadata-inspection");
    }
  }
}

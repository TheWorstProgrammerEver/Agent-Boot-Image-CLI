import { Buffer } from "node:buffer";

import type { SpawnHost } from "@agent-boot/process";

import { artifactFailure, throwIfArtifactCanceled } from "./cancellation.js";
import { ArtifactAcquisitionError } from "./errors.js";
import type { ArtifactImageMetadata, ArtifactMetadataInspector } from "./model.js";

const positiveInteger = (value: string | undefined): number | undefined => {
  if (value === undefined || !/^\d+$/u.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
};

export class XzMetadataInspector implements ArtifactMetadataInspector {
  readonly #commands: SpawnHost;

  constructor(commands: SpawnHost) {
    this.#commands = commands;
  }

  async inspect(
    path: string,
    compressedByteLength: number,
    cancellation?: AbortSignal,
  ): Promise<ArtifactImageMetadata> {
    try {
      throwIfArtifactCanceled(cancellation);
      const chunks: Uint8Array[] = [];
      let outputBytes = 0;
      let outputExceeded = false;
      const didExceedOutput = (): boolean => outputExceeded;
      let cancelRunning = (): void => undefined;
      const running = this.#commands.spawn({
        arguments: ["--robot", "--list", "--", path],
        ...(cancellation === undefined ? {} : { cancellation }),
        executable: "xz",
        label: "inspect verified OS artifact",
        lifetime: { policy: "managed" },
        onOutput: ({ data, stream }) => {
          if (stream !== "stdout" || outputExceeded) return;
          outputBytes += data.byteLength;
          if (outputBytes > 64 * 1_024) {
            outputExceeded = true;
            cancelRunning();
            return;
          }
          chunks.push(Uint8Array.from(data));
        },
        sensitiveValues: [path],
        stdio: "stream",
        timeoutMs: 30_000,
      });
      cancelRunning = (): void => { running.cancel(); };
      const completion = await running.completion;
      throwIfArtifactCanceled(cancellation);
      if (
        didExceedOutput() || completion.reason !== "exit" ||
        completion.exitCode !== 0
      ) throw new ArtifactAcquisitionError("metadata-inspection");
      const stdout = Buffer.concat(chunks).toString("utf8");
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
    } catch (error) {
      throw artifactFailure(error, cancellation, "metadata-inspection");
    }
  }
}

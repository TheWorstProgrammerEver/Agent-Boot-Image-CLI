import { Buffer } from "node:buffer";

import type { SpawnHost } from "@agent-boot/process";

import { customizationError } from "./errors.js";
import type {
  ImageCapacityProvisionRequest,
  ImageCapacityProvisioner,
} from "./model.js";

const maximumOutputBytes = 65_536;
const minimumGrowthReserveBytes = 64n * 1_024n * 1_024n;

interface PartitionGeometry {
  readonly number: number;
  readonly sizeBytes: bigint;
  readonly startBytes: bigint;
}

const positiveBigInt = (value: unknown): bigint | undefined => {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return BigInt(value);
  if (typeof value === "string" && /^[1-9][0-9]*$/u.test(value)) return BigInt(value);
  return undefined;
};

export const parseSfdiskRootGeometry = (
  source: string,
  targetPath: string,
  rootDevicePath: string,
): PartitionGeometry => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    throw customizationError("capacity-provision-failed");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed) ||
      !("partitiontable" in parsed) || typeof parsed.partitiontable !== "object" ||
      parsed.partitiontable === null || Array.isArray(parsed.partitiontable)) {
    throw customizationError("capacity-provision-failed");
  }
  const table = parsed.partitiontable as Record<string, unknown>;
  const sectorSize = positiveBigInt(table.sectorsize);
  if (table.device !== targetPath || table.unit !== "sectors" || sectorSize === undefined ||
      !Array.isArray(table.partitions) || table.partitions.length === 0) {
    throw customizationError("capacity-provision-failed");
  }
  const matches = table.partitions.flatMap((value, index) => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return [];
    const partition = value as Record<string, unknown>;
    if (partition.node !== rootDevicePath) return [];
    const start = positiveBigInt(partition.start);
    const size = positiveBigInt(partition.size);
    return start === undefined || size === undefined
      ? []
      : [{ number: index + 1, sizeBytes: size * sectorSize, startBytes: start * sectorSize }];
  });
  const match = matches[0];
  if (matches.length !== 1 || match === undefined || match.number !== table.partitions.length) {
    throw customizationError("capacity-provision-failed");
  }
  return match;
};

export interface CommandImageCapacityProvisionerOptions {
  readonly filesystemTimeoutMs?: number;
  readonly partitionTimeoutMs?: number;
}

export class CommandImageCapacityProvisioner implements ImageCapacityProvisioner {
  readonly #filesystemTimeoutMs: number;
  readonly #host: SpawnHost;
  readonly #partitionTimeoutMs: number;

  constructor(host: SpawnHost, options: CommandImageCapacityProvisionerOptions = {}) {
    this.#host = host;
    this.#filesystemTimeoutMs = options.filesystemTimeoutMs ?? 120_000;
    this.#partitionTimeoutMs = options.partitionTimeoutMs ?? 30_000;
  }

  async provision(request: ImageCapacityProvisionRequest, cancellation: AbortSignal): Promise<void> {
    if (request.rootPartition.filesystem !== "ext4" || request.rootPartition.role !== "root" ||
        request.requiredAdditionalBytes <= 0n) {
      throw customizationError("capacity-provision-failed");
    }
    const sensitive = [request.targetPath, request.rootPartition.devicePath];
    const table = await this.#run(
      "inspect root partition geometry",
      "sfdisk",
      ["--json", "--", request.targetPath],
      cancellation,
      this.#partitionTimeoutMs,
      sensitive,
      [0],
      true,
    );
    const geometry = parseSfdiskRootGeometry(
      table,
      request.targetPath,
      request.rootPartition.devicePath,
    );
    const targetSize = positiveBigInt((await this.#run(
      "inspect target capacity",
      "blockdev",
      ["--getsize64", request.targetPath],
      cancellation,
      this.#partitionTimeoutMs,
      sensitive,
      [0],
      true,
    )).trim());
    if (targetSize === undefined || targetSize <= geometry.startBytes + geometry.sizeBytes) {
      throw customizationError("capacity-insufficient");
    }
    const projectedSize = targetSize - geometry.startBytes;
    const growth = projectedSize - geometry.sizeBytes;
    if (growth < request.requiredAdditionalBytes + minimumGrowthReserveBytes) {
      throw customizationError("capacity-insufficient");
    }

    await this.#run(
      "grow root partition",
      "parted",
      ["--script", "--align", "optimal", "--", request.targetPath, "resizepart", String(geometry.number), "100%"],
      cancellation,
      this.#partitionTimeoutMs,
      sensitive,
    );
    await this.#run(
      "reread target partition table",
      "partprobe",
      [request.targetPath],
      cancellation,
      this.#partitionTimeoutMs,
      sensitive,
    );
    await this.#run(
      "settle resized target partitions",
      "udevadm",
      ["settle", "--timeout=10"],
      cancellation,
      15_000,
      sensitive,
    );
    const resizedPartitionSize = positiveBigInt((await this.#run(
      "verify resized root partition",
      "blockdev",
      ["--getsize64", request.rootPartition.devicePath],
      cancellation,
      this.#partitionTimeoutMs,
      sensitive,
      [0],
      true,
    )).trim());
    if (resizedPartitionSize === undefined ||
        resizedPartitionSize < geometry.sizeBytes + request.requiredAdditionalBytes) {
      throw customizationError("capacity-provision-failed");
    }

    await this.#run(
      "preflight resized root filesystem",
      "e2fsck",
      ["-f", "-p", request.rootPartition.devicePath],
      cancellation,
      this.#filesystemTimeoutMs,
      sensitive,
      [0, 1],
    );
    await this.#run(
      "grow root filesystem",
      "resize2fs",
      [request.rootPartition.devicePath],
      cancellation,
      this.#filesystemTimeoutMs,
      sensitive,
    );
    await this.#run(
      "verify grown root filesystem",
      "e2fsck",
      ["-f", "-p", request.rootPartition.devicePath],
      cancellation,
      this.#filesystemTimeoutMs,
      sensitive,
      [0, 1],
    );
  }

  async #run(
    label: string,
    executable: string,
    arguments_: readonly string[],
    cancellation: AbortSignal,
    timeoutMs: number,
    sensitiveValues: readonly string[],
    acceptedExitCodes: readonly number[] = [0],
    captureOutput = false,
  ): Promise<string> {
    const chunks: Buffer[] = [];
    let byteLength = 0;
    let exceeded = false;
    const outputExceeded = (): boolean => exceeded;
    const running = this.#host.spawn({
      arguments: arguments_,
      cancellation,
      executable,
      label,
      lifetime: { policy: "managed" },
      onOutput: ({ data, stream }) => {
        if (!captureOutput || stream !== "stdout" || exceeded) return;
        byteLength += data.byteLength;
        if (byteLength > maximumOutputBytes) {
          exceeded = true;
          running.cancel();
          return;
        }
        chunks.push(Buffer.from(data));
      },
      sensitiveValues,
      stdio: "stream",
      timeoutMs,
    });
    const result = await running.completion;
    if (cancellation.aborted || result.reason === "canceled") throw customizationError("canceled");
    const exitCode = result.exitCode;
    if (outputExceeded() || result.reason !== "exit" || exitCode === null ||
        !acceptedExitCodes.includes(exitCode)) {
      throw customizationError("capacity-provision-failed");
    }
    return Buffer.concat(chunks).toString("utf8");
  }
}

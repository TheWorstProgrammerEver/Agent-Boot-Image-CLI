import { Buffer } from "node:buffer";

import type { SpawnHost } from "@agent-boot/process";

import { customizationError } from "./errors.js";
import type { ImagePartitionInspector, InspectedImagePartition } from "./model.js";

const maximumOutputBytes = 1_048_576;

interface LsblkPartition extends Record<string, unknown> {
  readonly children?: unknown;
}

const optionalText = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;

const filesystemName = (value: string | undefined): string | undefined =>
  value === "vfat" ? "fat32" : value;

const parentDevicePath = (value: string | undefined): string | undefined =>
  value === undefined || value.startsWith("/") ? value : `/dev/${value}`;

const collectPartitions = (
  input: unknown,
  inheritedParent: string | undefined,
  output: InspectedImagePartition[],
): void => {
  if (typeof input !== "object" || input === null || Array.isArray(input)) throw new Error("invalid");
  const node = input as LsblkPartition;
  const path = optionalText(node.path);
  const type = optionalText(node.type);
  if (path === undefined || !path.startsWith("/")) throw new Error("invalid");
  const parentPath = parentDevicePath(optionalText(node.pkname)) ?? inheritedParent;
  if (type === "part") {
    if (parentPath === undefined) throw new Error("invalid");
    const filesystem = filesystemName(optionalText(node.fstype));
    const label = optionalText(node.label);
    output.push({
      devicePath: path,
      ...(filesystem === undefined ? {} : { filesystem }),
      ...(label === undefined ? {} : { label }),
      parentPath,
    });
  }
  if (node.children === undefined) return;
  if (!Array.isArray(node.children)) throw new Error("invalid");
  for (const child of node.children) collectPartitions(child, path, output);
};

export const parsePartitionLsblkJson = (source: string): readonly InspectedImagePartition[] => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    throw customizationError("partition-layout");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed) ||
      !("blockdevices" in parsed) || !Array.isArray(parsed.blockdevices)) {
    throw customizationError("partition-layout");
  }
  const output: InspectedImagePartition[] = [];
  try {
    for (const node of parsed.blockdevices) collectPartitions(node, undefined, output);
  } catch {
    throw customizationError("partition-layout");
  }
  return output;
};

export interface CommandImagePartitionInspectorOptions {
  readonly maxOutputBytes?: number;
  readonly timeoutMs?: number;
}

export class CommandImagePartitionInspector implements ImagePartitionInspector {
  readonly #host: SpawnHost;
  readonly #maxOutputBytes: number;
  readonly #timeoutMs: number;

  constructor(host: SpawnHost, options: CommandImagePartitionInspectorOptions = {}) {
    this.#host = host;
    this.#maxOutputBytes = options.maxOutputBytes ?? maximumOutputBytes;
    this.#timeoutMs = options.timeoutMs ?? 5_000;
  }

  async inspect(targetPath: string, cancellation: AbortSignal): Promise<readonly InspectedImagePartition[]> {
    const chunks: Buffer[] = [];
    let byteLength = 0;
    let exceeded = false;
    const outputExceeded = (): boolean => exceeded;
    const running = this.#host.spawn({
      arguments: ["--json", "--paths", "--tree", "--output", "PATH,PKNAME,TYPE,FSTYPE,LABEL", "--", targetPath],
      cancellation,
      executable: "lsblk",
      label: "inspect written image partitions",
      lifetime: { policy: "managed" },
      onOutput: ({ data, stream }) => {
        if (stream !== "stdout" || exceeded) return;
        byteLength += data.byteLength;
        if (byteLength > this.#maxOutputBytes) {
          exceeded = true;
          running.cancel();
          return;
        }
        chunks.push(Buffer.from(data));
      },
      sensitiveValues: [targetPath],
      stdio: "stream",
      timeoutMs: this.#timeoutMs,
    });
    const result = await running.completion;
    if (cancellation.aborted || result.reason === "canceled") throw customizationError("canceled");
    if (outputExceeded() || result.reason !== "exit" || result.exitCode !== 0) {
      throw customizationError("partition-layout");
    }
    return parsePartitionLsblkJson(Buffer.concat(chunks).toString("utf8"));
  }
}

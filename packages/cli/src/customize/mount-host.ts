import type { SpawnHost } from "@agent-boot/process";

import { customizationError } from "./errors.js";
import type { ImageMountHost, ValidatedImagePartition } from "./model.js";

const filesystemType = (filesystem: string): string => filesystem === "fat32" ? "vfat" : filesystem;

const mountOptions = (partition: ValidatedImagePartition): string =>
  partition.filesystem === "fat32"
    ? "uid=0,gid=0,fmask=0177,dmask=0077,nodev,nosuid,noexec"
    : "nodev,nosuid";

export interface CommandImageMountHostOptions {
  readonly timeoutMs?: number;
}

export class CommandImageMountHost implements ImageMountHost {
  readonly #host: SpawnHost;
  readonly #timeoutMs: number;

  constructor(host: SpawnHost, options: CommandImageMountHostOptions = {}) {
    this.#host = host;
    this.#timeoutMs = options.timeoutMs ?? 30_000;
  }

  async mount(
    partition: ValidatedImagePartition,
    mountPath: string,
    cancellation: AbortSignal,
  ): Promise<void> {
    const running = this.#host.spawn({
      arguments: [
        "--types", filesystemType(partition.filesystem),
        "--options", mountOptions(partition),
        "--source", partition.devicePath,
        "--target", mountPath,
      ],
      cancellation,
      executable: "mount",
      label: "mount image partition",
      lifetime: { policy: "managed" },
      sensitiveValues: [partition.devicePath, mountPath],
      stdio: "stream",
      timeoutMs: this.#timeoutMs,
    });
    const result = await running.completion;
    if (cancellation.aborted || result.reason === "canceled") throw customizationError("canceled");
    if (result.reason !== "exit" || result.exitCode !== 0) throw customizationError("mount-failed");
  }

  async unmount(mountPath: string, cancellation: AbortSignal): Promise<void> {
    const running = this.#host.spawn({
      arguments: ["--", mountPath],
      cancellation,
      executable: "umount",
      label: "unmount customized image partition",
      lifetime: { policy: "managed" },
      sensitiveValues: [mountPath],
      stdio: "stream",
      timeoutMs: this.#timeoutMs,
    });
    const result = await running.completion;
    if (result.reason !== "exit" || result.exitCode !== 0) throw customizationError("cleanup-failed");
  }
}

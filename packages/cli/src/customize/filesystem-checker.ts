import type { SpawnHost } from "@agent-boot/process";

import { customizationError } from "./errors.js";
import type { ImageFilesystemChecker, ValidatedImagePartition } from "./model.js";

export interface CommandImageFilesystemCheckerOptions {
  readonly timeoutMs?: number;
}

export class CommandImageFilesystemChecker implements ImageFilesystemChecker {
  readonly #host: SpawnHost;
  readonly #timeoutMs: number;

  constructor(host: SpawnHost, options: CommandImageFilesystemCheckerOptions = {}) {
    this.#host = host;
    this.#timeoutMs = options.timeoutMs ?? 300_000;
  }

  async check(partition: ValidatedImagePartition, cancellation: AbortSignal): Promise<void> {
    const command = partition.filesystem === "fat32"
      ? { arguments: ["-n", partition.devicePath], executable: "fsck.vfat" }
      : partition.filesystem === "ext4"
        ? { arguments: ["-f", "-n", partition.devicePath], executable: "e2fsck" }
        : undefined;
    if (command === undefined) throw customizationError("filesystem-check-failed");
    const running = this.#host.spawn({
      ...command,
      cancellation,
      label: "read-only image filesystem check",
      lifetime: { policy: "managed" },
      sensitiveValues: [partition.devicePath],
      stdio: "stream",
      timeoutMs: this.#timeoutMs,
    });
    const result = await running.completion;
    if (cancellation.aborted || result.reason === "canceled") throw customizationError("canceled");
    if (result.reason !== "exit" || result.exitCode !== 0) {
      throw customizationError("filesystem-check-failed");
    }
  }
}

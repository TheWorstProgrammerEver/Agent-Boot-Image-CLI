import type { SpawnHost } from "@agent-boot/process";

import { ImageWriteError } from "./errors.js";
import type { DescendantUnmounter } from "./model.js";

export interface CommandDescendantUnmounterOptions {
  readonly timeoutMs?: number;
}

export class CommandDescendantUnmounter implements DescendantUnmounter {
  readonly #host: SpawnHost;
  readonly #timeoutMs: number;

  constructor(host: SpawnHost, options: CommandDescendantUnmounterOptions = {}) {
    this.#host = host;
    this.#timeoutMs = options.timeoutMs ?? 30_000;
  }

  async unmount(mountpoint: string, cancellation: AbortSignal): Promise<void> {
    if (!mountpoint.startsWith("/")) {
      throw new TypeError("Descendant mountpoint must be an absolute path.");
    }
    const running = this.#host.spawn({
      arguments: ["--", mountpoint],
      cancellation,
      executable: "umount",
      label: "unmount target descendant",
      lifetime: { policy: "managed" },
      sensitiveValues: [mountpoint],
      stdio: "stream",
      timeoutMs: this.#timeoutMs,
    });
    const result = await running.completion;
    if (cancellation.aborted || result.reason === "canceled") {
      throw new ImageWriteError("canceled", "Descendant unmount was canceled.");
    }
    if (result.reason !== "exit" || result.exitCode !== 0) {
      throw new ImageWriteError("unmount-failed", "A target descendant could not be unmounted.");
    }
  }
}

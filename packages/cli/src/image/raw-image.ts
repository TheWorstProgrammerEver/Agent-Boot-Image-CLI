import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { lstat, rm } from "node:fs/promises";
import { join } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

import type { SpawnHost } from "@agent-boot/process";

import type { AcquiredOsArtifact } from "../images/index.js";
import { RawFileImageSource } from "../imaging/index.js";
import type { ImageWorkspace, PreparedImageSource } from "./model.js";

export class XzRawImagePreparer {
  readonly #commands: SpawnHost;

  constructor(commands: SpawnHost) {
    this.#commands = commands;
  }

  async prepare(
    artifact: AcquiredOsArtifact,
    workspace: ImageWorkspace,
    cancellation: AbortSignal,
  ): Promise<PreparedImageSource> {
    const compressedPath = join(workspace.path, "operating-system.img.xz");
    const rawPath = join(workspace.path, "operating-system.img");
    const digest = createHash("sha256");
    await pipeline(
      createReadStream(artifact.path),
      new Transform({
        transform(chunk: Uint8Array, _encoding, callback) {
          digest.update(chunk);
          callback(null, chunk);
        },
      }),
      createWriteStream(compressedPath, { flags: "wx", mode: 0o600 }),
      { signal: cancellation },
    );
    if (digest.digest("hex") !== artifact.sha256) {
      throw new Error("copied operating-system artifact did not match its pinned digest");
    }
    const running = this.#commands.spawn({
      arguments: ["--decompress", "--keep", "--", compressedPath],
      cancellation,
      executable: "xz",
      label: "prepare verified raw operating-system image",
      lifetime: { policy: "managed" },
      sensitiveValues: [compressedPath],
      stdio: "stream",
    });
    const completion = await running.completion;
    if (
      cancellation.aborted || completion.reason === "canceled" ||
      completion.reason !== "exit" || completion.exitCode !== 0
    ) throw new Error("raw image preparation failed");
    const metadata = await lstat(rawPath);
    if (
      !metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1 ||
      metadata.size !== artifact.imageByteLength
    ) throw new Error("raw image length did not match verified metadata");
    await rm(compressedPath);
    return { source: new RawFileImageSource(rawPath) };
  }
}

import { readdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";

import type { SpawnHost } from "@agent-boot/process";

import { parseLsblkJson } from "./lsblk.js";
import type { DriveInspector, DriveSnapshot, StableDeviceLink } from "./model.js";

const BY_ID_DIRECTORY = "/dev/disk/by-id";
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;

export interface StableLinkDirectoryEntry {
  readonly isSymbolicLink: boolean;
  readonly name: string;
}

export interface StableLinkFilesystem {
  list(directory: string): Promise<readonly StableLinkDirectoryEntry[]>;
  realpath(path: string): Promise<string>;
}

const defaultFilesystem: StableLinkFilesystem = {
  list: async (directory) => (await readdir(directory, { withFileTypes: true })).map((entry) => ({
    isSymbolicLink: entry.isSymbolicLink(),
    name: entry.name,
  })),
  realpath,
};

export interface LinuxDriveInspectorOptions {
  readonly filesystem?: StableLinkFilesystem;
  readonly platform?: NodeJS.Platform;
}

const captureLsblk = async (host: SpawnHost): Promise<string> => {
  const chunks: Uint8Array[] = [];
  let outputBytes = 0;
  const runningReference: { current?: ReturnType<SpawnHost["spawn"]> } = {};
  const running = host.spawn({
    executable: "lsblk",
    arguments: [
      "--json",
      "--bytes",
      "--paths",
      "--tree",
      "--output",
      "KNAME,PATH,PKNAME,TYPE,SIZE,MODEL,SERIAL,RM,TRAN,MOUNTPOINTS",
    ],
    label: "inspect block-device topology",
    lifetime: { policy: "managed" },
    onOutput: ({ data, stream }) => {
      if (stream !== "stdout") return;
      outputBytes += data.byteLength;
      if (outputBytes > MAX_OUTPUT_BYTES) {
        runningReference.current?.cancel();
        return;
      }
      chunks.push(Uint8Array.from(data));
    },
    stdio: "stream",
    timeoutMs: 5_000,
  });
  runningReference.current = running;
  if (outputBytes > MAX_OUTPUT_BYTES) running.cancel();
  const result = await running.completion;
  if (outputBytes > MAX_OUTPUT_BYTES) {
    throw new Error("Block-device inspection exceeded its output limit.");
  }
  if (result.reason !== "exit" || result.exitCode !== 0) {
    throw new Error("Block-device inspection command failed.");
  }
  const output = new Uint8Array(outputBytes);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(output);
};

const stableLinks = async (filesystem: StableLinkFilesystem): Promise<StableDeviceLink[]> => {
  const entries = await filesystem.list(BY_ID_DIRECTORY);
  const links = await Promise.all(entries
    .filter((entry) => entry.isSymbolicLink)
    .map(async (entry): Promise<StableDeviceLink> => {
      if (entry.name === "." || entry.name === ".." || entry.name.includes("/") ||
          /[\u0000-\u001f\u007f]/u.test(entry.name)) {
        throw new Error("Stable device-link directory contains an invalid entry.");
      }
      const path = join(BY_ID_DIRECTORY, entry.name);
      const resolvedPath = await filesystem.realpath(path);
      if (!resolvedPath.startsWith("/dev/") || /[\u0000-\u001f\u007f]/u.test(resolvedPath)) {
        throw new Error("Stable device link resolved outside the device namespace.");
      }
      return { path, resolvedPath };
    }));
  return links.sort((left, right) => left.path.localeCompare(right.path));
};

export class LinuxDriveInspector implements DriveInspector {
  readonly #filesystem: StableLinkFilesystem;
  readonly #host: SpawnHost;
  readonly #platform: NodeJS.Platform;

  constructor(host: SpawnHost, options: LinuxDriveInspectorOptions = {}) {
    this.#filesystem = options.filesystem ?? defaultFilesystem;
    this.#host = host;
    this.#platform = options.platform ?? process.platform;
  }

  async inspect(): Promise<DriveSnapshot> {
    if (this.#platform !== "linux") {
      throw new Error("Drive inspection requires a Linux imaging host.");
    }
    const [lsblk, links] = await Promise.all([
      captureLsblk(this.#host),
      stableLinks(this.#filesystem),
    ]);
    return { devices: parseLsblkJson(lsblk), stableLinks: links };
  }
}

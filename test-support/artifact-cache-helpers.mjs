import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { cachePathsFor } from "../packages/cli/dist/images/cache-layout.js";

export const chunks = (...values) => ({
  async *[Symbol.asyncIterator]() {
    for (const value of values) yield value;
  },
});

export const response = ({ body, headers = {}, status = 200 }) => {
  const normalized = new Map(
    Object.entries(headers).map(([name, value]) => [name.toLowerCase(), String(value)]),
  );
  return {
    body,
    header: name => normalized.get(name.toLowerCase()),
    status,
  };
};

export class ScriptedArtifactTransport {
  calls = [];
  #scripts;

  constructor(...scripts) {
    this.#scripts = scripts;
  }

  async request(request) {
    this.calls.push({ ...request });
    const script = this.#scripts.shift();
    if (script === undefined) throw new Error("offline transport");
    return typeof script === "function" ? script(request) : script;
  }
}

export const createArtifactFixture = async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-boot-artifact-test-"));
  const cacheDirectory = join(root, "cache");
  const payload = Buffer.from("verified compressed image fixture\n", "utf8");
  const sha256 = createHash("sha256").update(payload).digest("hex");
  const lock = {
    schemaVersion: 1,
    catalogId: "fixture-os-2026-07-19",
    operatingSystem: {
      family: "fixture-os",
      release: "fixture-release",
      variant: "lite",
      architecture: "arm64",
      boards: ["fixture-board"],
    },
    artifact: {
      url: "https://artifacts.example.invalid/2026-07-19-fixture.img.xz",
      sha256,
      byteLength: payload.byteLength,
    },
    partitions: [
      { role: "boot", filesystem: "fat32", label: "bootfs" },
      { role: "root", filesystem: "ext4", label: "rootfs" },
    ],
  };
  const inspectionCalls = [];
  const inspector = {
    async inspect(path, compressedByteLength) {
      inspectionCalls.push({ compressedByteLength, path });
      return {
        compressedByteLength,
        compressionFormat: "xz",
        imageByteLength: 4_096,
        imageFormat: "raw",
      };
    },
  };
  return {
    cacheDirectory,
    cleanup: () => rm(root, { recursive: true, force: true }),
    inspectionCalls,
    inspector,
    lock,
    paths: cachePathsFor(cacheDirectory, sha256),
    payload,
    root,
  };
};

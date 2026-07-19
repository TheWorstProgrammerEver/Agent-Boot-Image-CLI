import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { URL } from "node:url";

import { acquireOsArtifact, ArtifactAcquisitionError } from "@agent-boot/cli/images";
import { FakeCommandHost } from "@agent-boot/process";

import { createArtifactFixture, ScriptedArtifactTransport } from "../test-support/artifact-cache-helpers.mjs";

const lockUrl = new URL(
  "../packages/os-adapters/fixtures/raspberry-pi-os-lite-trixie-arm64.os-lock.json",
  import.meta.url,
);

const clone = value => JSON.parse(JSON.stringify(value));

test("the public acquisition boundary accepts only the exact curated URL and checksum", async () => {
  const fixture = await createArtifactFixture();
  try {
    const pinned = JSON.parse(await readFile(lockUrl, "utf8"));
    const alteredUrl = clone(pinned);
    alteredUrl.artifact.url =
      "https://diagnostic-secret.invalid/2026-06-18-raspios-trixie-arm64-lite.img.xz";
    const alteredChecksum = clone(pinned);
    alteredChecksum.artifact.sha256 = "0".repeat(64);
    const transport = new ScriptedArtifactTransport();

    for (const input of [alteredUrl, alteredChecksum, { ...pinned, catalogId: "latest" }]) {
      await assert.rejects(
        acquireOsArtifact(input, {
          cacheDirectory: fixture.cacheDirectory,
          commandHost: new FakeCommandHost(),
          transport,
        }),
        error =>
          error instanceof ArtifactAcquisitionError &&
          error.code === "unpinned-lock" &&
          !error.message.includes("diagnostic-secret"),
      );
    }
    assert.equal(transport.calls.length, 0);
  } finally {
    await fixture.cleanup();
  }
});

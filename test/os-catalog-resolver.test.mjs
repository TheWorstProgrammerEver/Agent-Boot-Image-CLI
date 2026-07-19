import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { URL } from "node:url";

import {
  OsCatalogResolutionError,
  OsCatalogValidationError,
  osCatalog,
} from "@agent-boot/os-adapters/catalog";

const lockFixtureUrl = new URL(
  "../packages/os-adapters/fixtures/raspberry-pi-os-lite-trixie-arm64.os-lock.json",
  import.meta.url,
);
const selection = {
  catalogId: "raspberry-pi-os-lite-trixie-arm64",
  architecture: "arm64",
  boards: ["raspberry-pi-5"],
};

test("resolution deterministically synthesizes the pinned OS lock snapshot", async () => {
  const expected = JSON.parse(await readFile(lockFixtureUrl, "utf8"));
  const first = osCatalog.resolve(selection);
  const second = osCatalog.resolve(JSON.parse(JSON.stringify(selection)));

  assert.deepEqual(first, expected);
  assert.deepEqual(second, expected);
  assert.equal(JSON.stringify(first), JSON.stringify(second));
  assert.ok(Object.isFrozen(first));
  assert.ok(Object.isFrozen(first.artifact));
  assert.ok(Object.isFrozen(first.partitions));
});

test("resolution performs no network access", () => {
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = () => {
    fetchCalls += 1;
    throw new Error("Network access is prohibited during catalog resolution.");
  };

  try {
    assert.deepEqual(osCatalog.resolve(selection).operatingSystem.boards, ["raspberry-pi-5"]);
    assert.equal(fetchCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("unknown, mutable, and merely upstream-listed releases fail closed", () => {
  for (const catalogId of [
    "raspberry-pi-os-lite-trixie-arm64-latest",
    "raspberry-pi-os-lite-bookworm-arm64",
    "raspberry-pi-os-lite-trixie-arm64-2026-04-13",
  ]) {
    assert.throws(
      () => osCatalog.resolve({ ...selection, catalogId }),
      (error) =>
        error instanceof OsCatalogResolutionError &&
        error.code === "unknown-catalog-id" &&
        /Unknown or uncurated catalog ID/u.test(error.message),
    );
  }

  assert.throws(
    () => osCatalog.resolve({ ...selection, release: "latest" }),
    (error) => error instanceof OsCatalogValidationError && /release.*Unknown field/u.test(error.message),
  );
});

test("incompatible architectures and boards fail closed", () => {
  assert.throws(
    () => osCatalog.resolve({ ...selection, architecture: "armhf" }),
    (error) =>
      error instanceof OsCatalogResolutionError &&
      error.code === "incompatible-architecture" &&
      /requires arm64/u.test(error.message),
  );

  assert.throws(
    () => osCatalog.resolve({ ...selection, boards: ["raspberry-pi-4"] }),
    (error) =>
      error instanceof OsCatalogResolutionError &&
      error.code === "unsupported-board" &&
      /not explicitly supported/u.test(error.message),
  );
});

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { URL } from "node:url";

import {
  OsCatalogValidationError,
  osCatalog,
  osCatalogEntrySchema,
  osCatalogSchema,
} from "@agent-boot/os-adapters/catalog";

const fixtureUrl = new URL(
  "../packages/os-adapters/fixtures/raspberry-pi-os-lite-trixie-arm64.json",
  import.meta.url,
);

const clone = (value) => JSON.parse(JSON.stringify(value));

const rejects = (value, pattern) => {
  assert.throws(
    () => osCatalogEntrySchema.parse(value),
    (error) => error instanceof OsCatalogValidationError && pattern.test(error.message),
  );
};

test("the pinned fixture is the catalog's only advertised entry", async () => {
  const fixture = JSON.parse(await readFile(fixtureUrl, "utf8"));
  const parsed = osCatalogEntrySchema.parse(fixture);

  assert.equal(osCatalog.entries.length, 1);
  assert.deepEqual(osCatalog.entries, [parsed]);
  assert.deepEqual(parsed.supportedBoards, ["raspberry-pi-5"]);
  assert.deepEqual(parsed.partitions, [
    { role: "boot", filesystem: "fat32", label: "bootfs" },
    { role: "root", filesystem: "ext4", label: "rootfs" },
  ]);
  assert.equal(
    parsed.artifact.checksum.digest,
    "acff736ca7945e3b305f07cda4abdb870910e12634991da69783611756e381b3",
  );
  assert.equal(parsed.artifact.byteLength, 524_875_608);
});

test("catalog validation rejects unknown fields and duplicate identities", async () => {
  const fixture = JSON.parse(await readFile(fixtureUrl, "utf8"));

  const unknown = clone(fixture);
  unknown.upstreamSupported = true;
  rejects(unknown, /upstreamSupported.*Unknown field/u);

  assert.throws(
    () => osCatalogSchema.parse([fixture, fixture]),
    (error) =>
      error instanceof OsCatalogValidationError &&
      /Duplicate identifier "raspberry-pi-os-lite-trixie-arm64"/u.test(error.message),
  );
});

test("catalog validation requires immutable artifact and checksum identities", async () => {
  const fixture = JSON.parse(await readFile(fixtureUrl, "utf8"));

  const mutable = clone(fixture);
  mutable.artifact.url = `https://downloads.raspberrypi.com/latest/${mutable.artifact.identity}`;
  rejects(mutable, /Mutable artifact URL aliases are not permitted/u);

  const mismatchedFile = clone(fixture);
  mismatchedFile.artifact.identity = "2026-06-18-raspios-trixie-arm64-full.img.xz";
  rejects(mismatchedFile, /artifact identity as the URL filename/u);

  const unpinnedLock = clone(fixture);
  unpinnedLock.lockId = unpinnedLock.catalogId;
  rejects(unpinnedLock, /catalog ID suffixed by the pinned publication date/u);

  const unrelatedChecksum = clone(fixture);
  unrelatedChecksum.artifact.checksum.sourceUrl =
    "https://downloads.raspberrypi.com/raspios_lite_arm64/latest.sha256";
  rejects(unrelatedChecksum, /checksum sidecar for the pinned artifact URL/u);
});

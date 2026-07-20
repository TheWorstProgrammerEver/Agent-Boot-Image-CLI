import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import {
  RaspberryPiOsCapacityError,
  calculateImagePlanCapacity,
  customizeRaspberryPiOsTrixie,
  preflightImagePlanCapacity,
} from "@agent-boot/os-adapters/raspberry-pi-os-trixie";

import {
  createAdapterFixture,
  passwordHasher,
  snapshotTree,
} from "../test-support/raspberry-pi-os-adapter-helpers.mjs";

const root = { gid: 0, uid: 0 };
const plan = [
  { contents: Buffer.alloc(4_097), identity: root, kind: "file", mode: 0o600, path: "a" },
  { identity: root, kind: "directory", mode: 0o700, path: "b" },
  { identity: root, kind: "symlink", linkTarget: "../a", path: "c" },
];

test("capacity planning rounds allocations and includes metadata, growth, and fixed reserves", () => {
  assert.deepEqual(calculateImagePlanCapacity(plan, 4_096n), {
    requiredBlocks: 16_393n,
    requiredInodes: 260n,
  });
});

test("capacity preflight checks available blocks and inodes independently", async t => {
  await t.test("sufficient", async () => {
    const result = await preflightImagePlanCapacity("root", "/fixture", plan, {
      inspect: async () => ({
        availableBlocks: 20_000n,
        blockSize: 4_096n,
        freeInodes: 1_000n,
        totalInodes: 2_000n,
      }),
    });
    assert.equal(result.requiredBlocks, 16_393n);
  });

  await t.test("block deficit", async () => {
    await assert.rejects(
      preflightImagePlanCapacity("root", "/fixture", plan, {
        inspect: async () => ({
          availableBlocks: 16_000n,
          blockSize: 4_096n,
          freeInodes: 1_000n,
          totalInodes: 2_000n,
        }),
      }),
      error => error instanceof RaspberryPiOsCapacityError &&
        error.role === "root" && error.details.requiredAdditionalBytes === 393n * 4_096n,
    );
  });

  await t.test("inode deficit", async () => {
    await assert.rejects(
      preflightImagePlanCapacity("root", "/fixture", plan, {
        inspect: async () => ({
          availableBlocks: 20_000n,
          blockSize: 4_096n,
          freeInodes: 10n,
          totalInodes: 100n,
        }),
      }),
      error => error instanceof RaspberryPiOsCapacityError &&
        error.details.requiredAdditionalBytes === 250n * 16_384n,
    );
  });

  await t.test("inode-less filesystem", async () => {
    await preflightImagePlanCapacity("boot", "/fixture", plan, {
      inspect: async () => ({
        availableBlocks: 20_000n,
        blockSize: 4_096n,
        freeInodes: 0n,
        totalInodes: 0n,
      }),
    });
  });
});

test("a complete root-plan capacity failure leaves every planned and secret-bearing file absent", async () => {
  const fixture = await createAdapterFixture();
  try {
    const before = await snapshotTree(join(fixture.root, "image"));
    const password = passwordHasher();
    await assert.rejects(
      customizeRaspberryPiOsTrixie(fixture.options({
        capacityInspector: {
          inspect: async path => path === fixture.boot
            ? { availableBlocks: 100_000n, blockSize: 4_096n, freeInodes: 0n, totalInodes: 0n }
            : { availableBlocks: 1n, blockSize: 4_096n, freeInodes: 1n, totalInodes: 100n },
        },
        passwordHasher: password.hasher,
      })),
      error => error instanceof RaspberryPiOsCapacityError && error.role === "root",
    );
    assert.deepEqual(await snapshotTree(join(fixture.root, "image")), before);
    for (const path of [
      join(fixture.boot, "userconf"),
      join(fixture.boot, "network-config"),
      join(fixture.systemRoot, "etc/agent-boot/bootstrap-secrets/credential"),
      join(fixture.systemRoot, "etc/systemd/system/agent-boot-runner.service"),
    ]) await assert.rejects(readFile(path));
  } finally {
    await fixture.cleanup();
  }
});

import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import test from "node:test";

import {
  CommandImageCapacityProvisioner,
  ImageCustomizationError,
  parseSfdiskRootGeometry,
} from "@agent-boot/cli/customize";
import { FakeCommandHost } from "@agent-boot/process";

const targetPath = "/dev/fixture";
const rootDevicePath = "/dev/fixture2";
const table = JSON.stringify({
  partitiontable: {
    device: targetPath,
    label: "dos",
    partitions: [
      { node: "/dev/fixture1", size: 1_048_576, start: 8_192 },
      { node: rootDevicePath, size: 4_751_360, start: 1_056_768 },
    ],
    sectorsize: 512,
    unit: "sectors",
  },
});
const rootPartition = {
  devicePath: rootDevicePath,
  filesystem: "ext4",
  label: "rootfs",
  role: "root",
};
const exit = (output = "", exitCode = 0) => ({
  output: output === "" ? [] : [{ data: Buffer.from(output), stream: "stdout" }],
  result: { exitCode, reason: "exit", signal: null },
});

test("parses the exact last root partition geometry from bounded sfdisk JSON", () => {
  assert.deepEqual(parseSfdiskRootGeometry(table, targetPath, rootDevicePath), {
    number: 2,
    sizeBytes: 2_432_696_320n,
    startBytes: 541_065_216n,
  });
  assert.throws(
    () => parseSfdiskRootGeometry(table, targetPath, "/dev/fixture1"),
    error => error instanceof ImageCustomizationError && error.code === "capacity-provision-failed",
  );
});

test("grows only a supported final ext4 root and verifies partition/filesystem operations", async () => {
  const commands = new FakeCommandHost();
  for (const script of [
    exit(table),
    exit("8589934592\n"),
    exit(),
    exit(),
    exit(),
    exit("8048869376\n"),
    exit("", 1),
    exit(),
    exit("", 1),
  ]) commands.scriptSpawnResult(script);
  const provisioner = new CommandImageCapacityProvisioner(commands);
  await provisioner.provision({
    requiredAdditionalBytes: 128n * 1_024n * 1_024n,
    rootPartition,
    targetPath,
  }, new globalThis.AbortController().signal);

  assert.deepEqual(commands.spawnCalls.map(call => [call.executable, call.arguments]), [
    ["sfdisk", ["--json", "--", targetPath]],
    ["blockdev", ["--getsize64", targetPath]],
    ["parted", ["--script", "--align", "optimal", "--", targetPath, "resizepart", "2", "100%"]],
    ["partprobe", [targetPath]],
    ["udevadm", ["settle", "--timeout=10"]],
    ["blockdev", ["--getsize64", rootDevicePath]],
    ["e2fsck", ["-f", "-p", rootDevicePath]],
    ["resize2fs", [rootDevicePath]],
    ["e2fsck", ["-f", "-p", rootDevicePath]],
  ]);
  assert.ok(commands.spawnCalls.every(call => call.timeoutMs > 0));
  assert.ok(commands.spawnCalls.every(call => call.sensitiveValues.includes(targetPath)));
});

test("insufficient trailing media capacity fails before partition or filesystem mutation", async () => {
  const commands = new FakeCommandHost()
    .scriptSpawnResult(exit(table))
    .scriptSpawnResult(exit("3040870400\n"));
  const provisioner = new CommandImageCapacityProvisioner(commands);
  await assert.rejects(
    provisioner.provision({
      requiredAdditionalBytes: 128n * 1_024n * 1_024n,
      rootPartition,
      targetPath,
    }, new globalThis.AbortController().signal),
    error => error instanceof ImageCustomizationError && error.code === "capacity-insufficient",
  );
  assert.deepEqual(commands.spawnCalls.map(call => call.executable), ["sfdisk", "blockdev"]);
});

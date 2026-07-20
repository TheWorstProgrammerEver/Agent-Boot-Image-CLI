import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  rm,
  truncate,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";
import test from "node:test";

import {
  CommandImageCapacityProvisioner,
  CommandImageFilesystemChecker,
  CommandImageMountHost,
  CommandImagePartitionInspector,
  ImageCustomizationError,
  RaspberryPiOsTrixieCustomizationAdapter,
  customizeWrittenImage,
  waitForImagePartitions,
} from "@agent-boot/cli/customize";
import {
  OpenSslPasswordHasher,
  PosixImageOwnership,
} from "@agent-boot/os-adapters";
import { NodeSpawnAdapter } from "@agent-boot/process";

const enabled = process.env.AGENT_BOOT_CAPACITY_LOOP === "1";
const imageXz = process.env.AGENT_BOOT_PINNED_IMAGE_XZ;
const assemblyDirectory = process.env.AGENT_BOOT_ASSEMBLY_DIRECTORY;
const runnerBundleDirectory = process.env.AGENT_BOOT_RUNNER_BUNDLE_DIRECTORY;
const skip = !enabled
  ? "set AGENT_BOOT_CAPACITY_LOOP=1 with the pinned image, assembly, and bundle paths"
  : process.getuid?.() !== 0
    ? "loop capacity integration requires root"
    : [imageXz, assemblyDirectory, runnerBundleDirectory].some(value => value === undefined)
      ? "capacity integration input paths are missing"
      : false;

const run = async (
  executable,
  arguments_,
  { acceptedExitCodes = [0], capture = false } = {},
) => {
  const chunks = [];
  let byteLength = 0;
  const child = spawn(executable, arguments_, { stdio: ["ignore", capture ? "pipe" : "ignore", "ignore"] });
  child.stdout?.on("data", data => {
    byteLength += data.byteLength;
    if (byteLength <= 65_536) chunks.push(Buffer.from(data));
    else child.kill("SIGKILL");
  });
  const result = await new Promise((resolveResult, reject) => {
    child.once("error", reject);
    child.once("exit", (exitCode, signal) => resolveResult({ exitCode, signal }));
  });
  assert.equal(result.signal, null);
  assert.ok(acceptedExitCodes.includes(result.exitCode));
  assert.ok(byteLength <= 65_536);
  return Buffer.concat(chunks).toString("utf8");
};

const decompress = async (source, destination) => {
  const output = await open(destination, "wx", 0o600);
  try {
    const child = spawn("xz", ["--decompress", "--stdout", "--", source], {
      stdio: ["ignore", output.fd, "ignore"],
    });
    const result = await new Promise((resolveResult, reject) => {
      child.once("error", reject);
      child.once("exit", (exitCode, signal) => resolveResult({ exitCode, signal }));
    });
    assert.deepEqual(result, { exitCode: 0, signal: null });
  } finally {
    await output.close();
  }
};

const secretIds = (manifest, runnerPlan) => {
  const ids = new Set();
  if (manifest.bootstrap.account.initialPassword !== undefined) {
    ids.add(manifest.bootstrap.account.initialPassword.secretId);
  }
  if (manifest.bootstrap.network?.wifi !== undefined) {
    ids.add(manifest.bootstrap.network.wifi.passphrase.secretId);
  }
  for (const step of runnerPlan.steps) {
    if (step.kind === "install-user-secret") ids.add(step.secretId);
    if (step.kind === "prompt") {
      for (const variable of step.variables) {
        if (variable.source.kind === "secret") ids.add(variable.source.secretId);
      }
    }
  }
  return ids;
};

const inspectPartitions = async (targetPath, osLock, commands) => waitForImagePartitions({
  cancellation: new globalThis.AbortController().signal,
  inspector: new CommandImagePartitionInspector(commands),
  osLock,
  targetPath,
});

const withReadOnlyMount = async (partition, root, verify) => {
  await mkdir(root, { mode: 0o700 });
  const options = partition.filesystem === "ext4"
    ? "ro,noload,nodev,nosuid,noexec"
    : "ro,nodev,nosuid,noexec";
  await run("mount", ["--types", partition.filesystem === "fat32" ? "vfat" : "ext4", "--options", options,
    "--source", partition.devicePath, "--target", root]);
  try {
    await verify(root);
  } finally {
    await run("umount", ["--", root]);
  }
};

const snapshotPath = async path => {
  try {
    const status = await lstat(path);
    return status.isFile()
      ? {
          kind: "file",
          mode: status.mode & 0o777,
          sha256: createHash("sha256").update(await readFile(path)).digest("hex"),
        }
      : { kind: status.isDirectory() ? "directory" : "other", mode: status.mode & 0o777 };
  } catch (error) {
    if (error?.code === "ENOENT") return { kind: "missing" };
    throw error;
  }
};

const snapshotMountedPaths = async (partition, root, paths) => {
  let snapshot;
  await withReadOnlyMount(partition, root, async mountRoot => {
    snapshot = await Promise.all(paths.map(path => snapshotPath(join(mountRoot, path))));
  });
  return snapshot;
};

const assertFilesystemsClean = async partitions => {
  for (const partition of partitions) {
    if (partition.filesystem === "fat32") {
      await run("fsck.vfat", ["-n", partition.devicePath], { acceptedExitCodes: [0, 1] });
    } else {
      await run("e2fsck", ["-f", "-n", partition.devicePath], { acceptedExitCodes: [0, 1] });
    }
  }
};

test("exact pinned image shape fails closed and an enlarged loop target completes", { skip }, async () => {
  const source = resolve(imageXz);
  const assembly = resolve(assemblyDirectory);
  const bundle = resolve(runnerBundleDirectory);
  const osLock = JSON.parse(await readFile(join(assembly, "os-lock.json"), "utf8"));
  const manifest = JSON.parse(await readFile(join(assembly, "manifest.json"), "utf8"));
  const runnerPlan = JSON.parse(await readFile(join(assembly, "runner-plan.json"), "utf8"));
  const bundleManifest = JSON.parse(await readFile(join(bundle, "manifest.json"), "utf8"));
  assert.equal(bundleManifest.entries.length, 5_911);
  const checksum = (await run("sha256sum", ["--", source], { capture: true })).split(/\s+/u)[0];
  assert.equal(checksum, osLock.artifact.sha256);

  const temporaryRoot = await mkdtemp(join(tmpdir(), "agent-boot-capacity-loop-"));
  await chmod(temporaryRoot, 0o700);
  const loops = [];
  const commands = new NodeSpawnAdapter();
  const account = {
    gid: 1000,
    group: manifest.bootstrap.account.username,
    homeDirectory: `/home/${manifest.bootstrap.account.username}`,
    uid: 1000,
    username: manifest.bootstrap.account.username,
    workingDirectory: `/home/${manifest.bootstrap.account.username}/workspace`,
  };
  const bootstrapSecrets = new Map([...secretIds(manifest, runnerPlan)].map((id, index) => [
    id,
    Buffer.from(`capacity-loop-fixture-${String(index)}`, "utf8"),
  ]));
  const dependencies = {
    adapter: new RaspberryPiOsTrixieCustomizationAdapter({
      account,
      ownership: new PosixImageOwnership(),
      passwordHasher: new OpenSslPasswordHasher({ commandHost: commands }),
    }),
    capacityProvisioner: new CommandImageCapacityProvisioner(commands),
    filesystemChecker: new CommandImageFilesystemChecker(commands),
    mountHost: new CommandImageMountHost(commands),
    partitionInspector: new CommandImagePartitionInspector(commands),
  };
  const requestFor = targetPath => ({
    assemblyDirectory: assembly,
    bootstrapSecrets,
    osLock,
    runnerBundleDirectory: bundle,
    targetPath,
  });

  const attach = async image => {
    const loop = (await run("losetup", ["--find", "--show", "--partscan", "--", image], { capture: true })).trim();
    assert.match(loop, /^\/dev\/loop[0-9]+$/u);
    loops.push(loop);
    await run("udevadm", ["settle", "--timeout=10"]);
    return loop;
  };
  const detach = async loop => {
    await run("losetup", ["--detach", loop]);
    loops.splice(loops.indexOf(loop), 1);
  };

  try {
    const exactImage = join(temporaryRoot, "exact.img");
    await decompress(source, exactImage);
    const exactLoop = await attach(exactImage);
    const initialPartitions = await inspectPartitions(exactLoop, osLock, commands);
    const initialBoot = initialPartitions.find(partition => partition.role === "boot");
    const initialRoot = initialPartitions.find(partition => partition.role === "root");
    assert.ok(initialBoot !== undefined && initialRoot !== undefined);
    const bootPaths = ["userconf", "network-config", "ssh"];
    const rootPaths = [
      "etc/agent-boot/manifest.json",
      "etc/agent-boot/bootstrap-secrets",
      "etc/agent-boot/bootstrap-secrets/credential",
      "etc/systemd/system/agent-boot-runner.service",
      "opt/agent-boot",
    ];
    const bootBefore = await snapshotMountedPaths(
      initialBoot,
      join(temporaryRoot, "initial-boot"),
      bootPaths,
    );
    const rootBefore = await snapshotMountedPaths(
      initialRoot,
      join(temporaryRoot, "initial-root"),
      rootPaths,
    );
    await assert.rejects(
      customizeWrittenImage(requestFor(exactLoop), dependencies),
      error => error instanceof ImageCustomizationError && error.code === "capacity-insufficient",
    );
    const exactPartitions = await inspectPartitions(exactLoop, osLock, commands);
    const boot = exactPartitions.find(partition => partition.role === "boot");
    const root = exactPartitions.find(partition => partition.role === "root");
    assert.ok(boot !== undefined && root !== undefined);
    assert.deepEqual(
      await snapshotMountedPaths(boot, join(temporaryRoot, "exact-boot"), bootPaths),
      bootBefore,
    );
    assert.deepEqual(
      await snapshotMountedPaths(root, join(temporaryRoot, "exact-root"), rootPaths),
      rootBefore,
    );
    assert.equal(rootBefore[2].kind, "missing");
    await assertFilesystemsClean(exactPartitions);
    await detach(exactLoop);
    await rm(exactImage, { force: true });

    const enlargedImage = join(temporaryRoot, "enlarged.img");
    await decompress(source, enlargedImage);
    await truncate(enlargedImage, 8 * 1_024 * 1_024 * 1_024);
    const enlargedLoop = await attach(enlargedImage);
    const result = await customizeWrittenImage(requestFor(enlargedLoop), dependencies);
    assert.ok(result.assertions.every(assertion => assertion.status === "passed"));
    assert.equal(result.filesystemChecks.length, 2);
    const enlargedPartitions = await inspectPartitions(enlargedLoop, osLock, commands);
    const enlargedRoot = enlargedPartitions.find(partition => partition.role === "root");
    assert.ok(enlargedRoot !== undefined);
    await withReadOnlyMount(enlargedRoot, join(temporaryRoot, "enlarged-root"), async mountRoot => {
      for (const path of [
        "etc/agent-boot/manifest.json",
        "etc/agent-boot/bootstrap-secrets",
        "etc/systemd/system/agent-boot-runner.service",
        "opt/agent-boot/runtime/bin/node",
      ]) assert.ok(await lstat(join(mountRoot, path)));
    });
    await assertFilesystemsClean(enlargedPartitions);
    await detach(enlargedLoop);
  } finally {
    bootstrapSecrets.forEach(value => { value.fill(0); });
    for (const loop of [...loops].reverse()) {
      try {
        await run("losetup", ["--detach", loop]);
      } catch {
        // The retained assertion failure remains primary; outer leftover checks report cleanup drift.
      }
    }
    await rm(temporaryRoot, { force: true, recursive: true });
  }
});

import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { EventEmitter } from "node:events";
import { chmod, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { URL } from "node:url";

import {
  CommandImageFilesystemChecker,
  CommandImageMountHost,
  CommandImagePartitionInspector,
  ImageCustomizationError,
  RaspberryPiOsTrixieCustomizationAdapter,
  SystemPrivateMountRootFactory,
  customizeWrittenImage,
  parsePartitionLsblkJson,
} from "@agent-boot/cli/customize";
import { RaspberryPiOsCapacityError } from "@agent-boot/os-adapters";
import { FakeCommandHost } from "@agent-boot/process";

import {
  createAdapterFixture,
  passwordHasher,
} from "../test-support/raspberry-pi-os-adapter-helpers.mjs";

const targetPath = "/fixture/target";
const secretText = "fixture-transaction-secret";
const successResult = {
  assertions: [{ id: "fixture-postcondition", path: "/fixture", status: "passed" }],
  assemblyId: "fixture-assembly",
  catalogId: "raspberry-pi-os-lite-trixie-arm64-2026-06-18",
};

const validPartitions = [
  {
    devicePath: "/fixture/target1",
    filesystem: "fat32",
    label: "bootfs",
    parentPath: targetPath,
  },
  {
    devicePath: "/fixture/target2",
    filesystem: "ext4",
    label: "rootfs",
    parentPath: targetPath,
  },
];

const createClock = () => {
  let milliseconds = 0;
  return {
    now: () => milliseconds,
    sleep: async delay => { milliseconds += delay; },
  };
};

const createHarness = async (overrides = {}) => {
  const root = await mkdtemp(join(tmpdir(), "agent-boot-customize-test-"));
  await chmod(root, 0o700);
  const events = [];
  const mounted = [];
  const mountRoles = new Map();
  const signalSource = new EventEmitter();
  let removed = false;
  const dependencies = {
    adapter: {
      customize: async (request, cancellation) => {
        events.push("adapter");
        await overrides.onAdapter?.(request, cancellation, signalSource);
        return overrides.adapterResult ?? successResult;
      },
    },
    ...(overrides.onProvision === undefined ? {} : {
      capacityProvisioner: {
        provision: async (request, cancellation) => {
          events.push("provision");
          await overrides.onProvision(request, cancellation, signalSource);
        },
      },
    }),
    clock: createClock(),
    filesystemChecker: {
      check: async (partition, cancellation) => {
        events.push(`check:${partition.role}`);
        await overrides.onCheck?.(partition, cancellation, signalSource);
      },
    },
    mountHost: {
      mount: async (partition, mountPath, cancellation) => {
        events.push(`mount:${partition.role}`);
        mountRoles.set(mountPath, partition.role);
        await overrides.onMount?.(partition, mountPath, cancellation, signalSource);
        mounted.push({ mountPath, role: partition.role });
        await overrides.onMounted?.(partition, mountPath, cancellation, signalSource);
      },
      unmount: async mountPath => {
        const entry = mounted.find(item => item.mountPath === mountPath);
        const role = mountRoles.get(mountPath);
        assert.ok(role);
        events.push(`unmount:${role}`);
        await overrides.onUnmount?.({ mountPath, role }, signalSource);
        if (entry !== undefined) mounted.splice(mounted.indexOf(entry), 1);
        mountRoles.delete(mountPath);
      },
    },
    mountRootFactory: {
      create: async () => ({
        path: root,
        remove: async () => {
          events.push("remove-root");
          await overrides.onRemove?.();
          removed = true;
          await rm(root, { force: true, recursive: true });
        },
      }),
    },
    partitionInspector: {
      inspect: async (_target, cancellation) => {
        events.push("inspect");
        return await overrides.onInspect?.(cancellation, signalSource) ?? validPartitions;
      },
    },
    partitionPollIntervalMs: overrides.partitionPollIntervalMs ?? 1,
    partitionTimeoutMs: overrides.partitionTimeoutMs ?? 3,
    signalSource,
  };
  const request = {
    assemblyDirectory: "/fixture/assembly",
    bootstrapSecrets: new Map([["credential", Buffer.from(secretText)]]),
    osLock: overrides.osLock,
    runnerBundleDirectory: "/fixture/bundle",
    targetPath,
  };
  return {
    cleanup: () => rm(root, { force: true, recursive: true }),
    dependencies,
    events,
    isRemoved: () => removed,
    mounted,
    request,
    root,
  };
};

const rootCapacityError = () => new RaspberryPiOsCapacityError("root", {
  availableBlocks: 1n,
  availableInodes: 1n,
  blockSize: 4_096n,
  requiredAdditionalBytes: 128n * 1_024n * 1_024n,
  requiredBlocks: 40_000n,
  requiredInodes: 8_000n,
});

const loadLock = async () => JSON.parse(await readFile(new URL(
  "../packages/os-adapters/fixtures/raspberry-pi-os-lite-trixie-arm64.os-lock.json",
  import.meta.url,
), "utf8"));

const assertCustomizationError = async (promise, code) => {
  await assert.rejects(promise, error => {
    assert.ok(error instanceof ImageCustomizationError);
    assert.equal(error.code, code);
    assert.doesNotMatch(`${error.name}:${error.message}:${error.stack}:${JSON.stringify(error.cause)}`, new RegExp(secretText, "u"));
    return true;
  });
};

test("waits for the exact locked partition layout before mounting", async () => {
  const lock = await loadLock();
  let inspection = 0;
  const harness = await createHarness({
    osLock: lock,
    onInspect: async () => {
      inspection += 1;
      if (inspection === 1) return [];
      if (inspection === 2) return [validPartitions[0]];
      return validPartitions;
    },
    partitionTimeoutMs: 5,
  });
  try {
    const result = await customizeWrittenImage(harness.request, harness.dependencies);
    assert.deepEqual(result.filesystemChecks, [
      { filesystem: "fat32", role: "boot", status: "passed" },
      { filesystem: "ext4", role: "root", status: "passed" },
    ]);
    assert.deepEqual(harness.events, [
      "inspect", "inspect", "inspect",
      "mount:boot", "mount:root", "adapter",
      "unmount:root", "unmount:boot",
      "check:boot", "check:root", "remove-root",
    ]);
    assert.deepEqual(harness.mounted, []);
    assert.equal(harness.isRemoved(), true);
    await assert.rejects(stat(harness.root));
  } finally {
    await harness.cleanup();
  }
});

test("provisions a larger root offline, revalidates topology, and retries exactly once", async () => {
  const lock = await loadLock();
  let adapterCalls = 0;
  const harness = await createHarness({
    osLock: lock,
    onAdapter: async () => {
      adapterCalls += 1;
      if (adapterCalls === 1) throw rootCapacityError();
    },
    onProvision: async request => {
      assert.equal(request.rootPartition.role, "root");
      assert.equal(request.requiredAdditionalBytes, 128n * 1_024n * 1_024n);
    },
  });
  try {
    await customizeWrittenImage(harness.request, harness.dependencies);
    assert.deepEqual(harness.events, [
      "inspect", "mount:boot", "mount:root", "adapter",
      "unmount:root", "unmount:boot", "provision", "inspect",
      "mount:boot", "mount:root", "adapter",
      "unmount:root", "unmount:boot", "check:boot", "check:root", "remove-root",
    ]);
    assert.equal(adapterCalls, 2);
    assert.deepEqual(harness.mounted, []);
  } finally {
    await harness.cleanup();
  }
});

test("an unprovisionable root fails with no retry and no mounted secret-bearing source", async () => {
  const lock = await loadLock();
  let adapterCalls = 0;
  const harness = await createHarness({
    osLock: lock,
    onAdapter: async () => {
      adapterCalls += 1;
      throw rootCapacityError();
    },
    onProvision: async () => { throw new ImageCustomizationError("capacity-insufficient"); },
  });
  try {
    await assertCustomizationError(
      customizeWrittenImage(harness.request, harness.dependencies),
      "capacity-insufficient",
    );
    assert.equal(adapterCalls, 1);
    assert.deepEqual(harness.mounted, []);
    assert.deepEqual(
      harness.events.filter(event => event === "provision" || event.startsWith("unmount:")),
      ["unmount:root", "unmount:boot", "provision"],
    );
  } finally {
    await harness.cleanup();
  }
});

test("rejects a wrong partition layout without mounting", async () => {
  const lock = await loadLock();
  const wrong = validPartitions.map(partition =>
    partition.filesystem === "fat32" ? { ...partition, label: "wrong" } : partition);
  const harness = await createHarness({ osLock: lock, onInspect: async () => wrong });
  try {
    await assertCustomizationError(
      customizeWrittenImage(harness.request, harness.dependencies),
      "partition-layout",
    );
    assert.equal(harness.events.some(event => event.startsWith("mount:")), false);
    assert.equal(harness.isRemoved(), false);
  } finally {
    await harness.cleanup();
  }
});

test("bounds absent partitions and rejects OS lock drift before inspection", async () => {
  const lock = await loadLock();
  const absent = await createHarness({ osLock: lock, onInspect: async () => [] });
  try {
    await assertCustomizationError(
      customizeWrittenImage(absent.request, absent.dependencies),
      "partition-timeout",
    );
    assert.equal(absent.events.filter(event => event === "inspect").length, 4);
  } finally {
    await absent.cleanup();
  }

  const drift = await createHarness({
    osLock: { ...lock, artifact: { ...lock.artifact, byteLength: lock.artifact.byteLength + 1 } },
  });
  try {
    await assertCustomizationError(
      customizeWrittenImage(drift.request, drift.dependencies),
      "invalid-input",
    );
    assert.deepEqual(drift.events, []);
  } finally {
    await drift.cleanup();
  }
});

test("system mount roots are private and removable", async () => {
  const root = await new SystemPrivateMountRootFactory().create();
  try {
    assert.equal((await stat(root.path)).mode & 0o777, 0o700);
  } finally {
    await root.remove();
  }
  await assert.rejects(stat(root.path));
});

test("adapter, mount, postcondition, and fsck failures clean up in reverse order", async t => {
  const lock = await loadLock();
  const cases = [
    {
      code: "mount-failed",
      name: "mount",
      overrides: { onMount: async partition => {
        if (partition.role === "root") throw new Error(secretText);
      } },
      unmounts: ["unmount:root", "unmount:boot"],
    },
    {
      code: "adapter-failed",
      name: "adapter",
      overrides: { onAdapter: async () => { throw new Error(secretText); } },
      unmounts: ["unmount:root", "unmount:boot"],
    },
    {
      code: "postcondition-failed",
      name: "postcondition",
      overrides: { adapterResult: { ...successResult, assertions: [] } },
      unmounts: ["unmount:root", "unmount:boot"],
    },
    {
      code: "postcondition-failed",
      name: "reported failed postcondition",
      overrides: {
        adapterResult: {
          ...successResult,
          assertions: [{ id: "reported-failure", path: "/fixture", status: "failed" }],
        },
      },
      unmounts: ["unmount:root", "unmount:boot"],
    },
    {
      code: "filesystem-check-failed",
      name: "filesystem check",
      overrides: { onCheck: async partition => {
        if (partition.role === "root") throw new Error(secretText);
      } },
      unmounts: ["unmount:root", "unmount:boot"],
    },
  ];
  for (const scenario of cases) await t.test(scenario.name, async () => {
    const harness = await createHarness({ osLock: lock, ...scenario.overrides });
    try {
      await assertCustomizationError(
        customizeWrittenImage(harness.request, harness.dependencies),
        scenario.code,
      );
      assert.deepEqual(
        harness.events.filter(event => event.startsWith("unmount:")),
        scenario.unmounts,
      );
      assert.deepEqual(harness.mounted, []);
      assert.equal(harness.isRemoved(), true);
    } finally {
      await harness.cleanup();
    }
  });
});

test("retains cleanup responsibility when mount acquisition settles ambiguously", async t => {
  const lock = await loadLock();
  for (const scenario of [
    {
      code: "mount-failed",
      name: "side effect before failure",
      onMounted: async partition => {
        if (partition.role === "root") throw new Error("fixture completion failure");
      },
    },
    {
      code: "canceled",
      name: "side effect before cancellation",
      onMounted: async (partition, _path, _cancellation, signals) => {
        if (partition.role === "root") {
          signals.emit("SIGTERM");
          throw new Error("fixture canceled completion");
        }
      },
    },
  ]) await t.test(scenario.name, async () => {
    const harness = await createHarness({ osLock: lock, onMounted: scenario.onMounted });
    try {
      await assertCustomizationError(
        customizeWrittenImage(harness.request, harness.dependencies),
        scenario.code,
      );
      assert.deepEqual(
        harness.events.filter(event => event.startsWith("unmount:")),
        ["unmount:root", "unmount:boot"],
      );
      assert.deepEqual(harness.mounted, []);
      assert.equal(harness.isRemoved(), true);
    } finally {
      await harness.cleanup();
    }
  });
});

test("retries failed unmount cleanup without hiding the cleanup failure", async () => {
  const lock = await loadLock();
  let failed = false;
  const harness = await createHarness({
    osLock: lock,
    onUnmount: async entry => {
      if (entry.role === "root" && !failed) {
        failed = true;
        throw new Error("fixture unmount failure");
      }
    },
  });
  try {
    await assertCustomizationError(
      customizeWrittenImage(harness.request, harness.dependencies),
      "cleanup-failed",
    );
    assert.deepEqual(
      harness.events.filter(event => event.startsWith("unmount:")),
      ["unmount:root", "unmount:boot", "unmount:root"],
    );
    assert.deepEqual(harness.mounted, []);
    assert.equal(harness.isRemoved(), true);
  } finally {
    await harness.cleanup();
  }
});

test("cleanup-only failure after checks reports a complete target milestone", async () => {
  const lock = await loadLock();
  const harness = await createHarness({
    osLock: lock,
    onRemove: async () => { throw new Error("fixture mount-root removal failure"); },
  });
  try {
    await assert.rejects(
      customizeWrittenImage(harness.request, harness.dependencies),
      error => {
        assert.ok(error instanceof ImageCustomizationError);
        assert.equal(error.code, "cleanup-failed");
        assert.equal(error.cleanupOnly, true);
        assert.equal(error.completedPhase, "check");
        return true;
      },
    );
    assert.deepEqual(harness.mounted, []);
    assert.equal(harness.isRemoved(), false);
  } finally {
    await harness.cleanup();
  }
});

test("signals cancel every phase and unmount all completed mounts in reverse order", async t => {
  const lock = await loadLock();
  for (const phase of ["partition", "mount-boot", "mount-root", "adapter", "check-boot", "check-root"]) {
    await t.test(phase, async () => {
      const harness = await createHarness({
        osLock: lock,
        onAdapter: async (_request, _cancellation, signals) => {
          if (phase === "adapter") signals.emit("SIGTERM");
        },
        onCheck: async (partition, _cancellation, signals) => {
          if (phase === `check-${partition.role}`) signals.emit("SIGTERM");
        },
        onInspect: async (_cancellation, signals) => {
          if (phase === "partition") signals.emit("SIGTERM");
          return validPartitions;
        },
        onMount: async (partition, _path, _cancellation, signals) => {
          if (phase === `mount-${partition.role}`) signals.emit("SIGTERM");
        },
      });
      try {
        await assertCustomizationError(
          customizeWrittenImage(harness.request, harness.dependencies),
          "canceled",
        );
        const mountEvents = harness.events.filter(event => event.startsWith("mount:"));
        const unmountEvents = harness.events.filter(event => event.startsWith("unmount:"));
        assert.deepEqual(
          unmountEvents,
          [...mountEvents].reverse().map(event => event.replace("mount:", "unmount:")),
        );
        assert.deepEqual(harness.mounted, []);
        assert.equal(harness.isRemoved(), phase === "partition" ? false : true);
      } finally {
        await harness.cleanup();
      }
    });
  }
});

test("the Raspberry Pi adapter alone places assembly files and bootstrap secret bytes", async () => {
  const fixture = await createAdapterFixture();
  const imageRoot = join(fixture.root, "image");
  await chmod(imageRoot, 0o700);
  const password = passwordHasher();
  const events = [];
  const options = fixture.options();
  try {
    const result = await customizeWrittenImage({
      assemblyDirectory: fixture.assembly,
      bootstrapSecrets: options.bootstrapSecrets,
      osLock: fixture.osLock,
      runnerBundleDirectory: fixture.bundle,
      targetPath,
    }, {
      adapter: new RaspberryPiOsTrixieCustomizationAdapter({
        account: fixture.account,
        ownership: fixture.ownership,
        passwordHasher: password.hasher,
      }),
      filesystemChecker: { check: async partition => { events.push(`check:${partition.role}`); } },
      mountHost: {
        mount: async partition => { events.push(`mount:${partition.role}`); },
        unmount: async mountPath => { events.push(`unmount:${mountPath.endsWith("/root") ? "root" : "boot"}`); },
      },
      mountRootFactory: { create: async () => ({ path: imageRoot, remove: async () => undefined }) },
      partitionInspector: { inspect: async () => validPartitions },
    });

    const runnerSecretPath = join(fixture.systemRoot, "etc/agent-boot/bootstrap-secrets/credential");
    assert.equal(await readFile(runnerSecretPath, "utf8"), "fixture-runner-secret");
    assert.equal((await stat(runnerSecretPath)).mode & 0o777, 0o600);
    assert.equal((await stat(join(fixture.systemRoot, "etc/agent-boot/bootstrap-secrets"))).mode & 0o777, 0o700);
    for (const ordinaryPath of ["etc/agent-boot/manifest.json", "etc/agent-boot/plan.json"]) {
      const contents = await readFile(join(fixture.systemRoot, ordinaryPath), "utf8");
      for (const secret of [
        "fixture-account-password",
        "fixture-runner-secret",
        "fixture-wifi-passphrase",
      ]) assert.doesNotMatch(contents, new RegExp(secret, "u"));
    }
    assert.doesNotMatch(JSON.stringify(result), /fixture-(?:account-password|runner-secret|wifi-passphrase)/u);
    assert.deepEqual(events.slice(-4), ["unmount:root", "unmount:boot", "check:boot", "check:root"]);
  } finally {
    await fixture.cleanup();
  }
});

test("command adapters use bounded discovery, restrictive FAT mounts, and read-only fsck", async () => {
  const parsed = parsePartitionLsblkJson(JSON.stringify({
    blockdevices: [{
      children: [
        { fstype: "vfat", label: "bootfs", path: "/dev/fixture1", pkname: "fixture", type: "part" },
        { fstype: "ext4", label: "rootfs", path: "/dev/fixture2", pkname: "fixture", type: "part" },
      ],
      path: "/dev/fixture",
      type: "disk",
    }],
  }));
  assert.deepEqual(parsed, [
    { devicePath: "/dev/fixture1", filesystem: "fat32", label: "bootfs", parentPath: "/dev/fixture" },
    { devicePath: "/dev/fixture2", filesystem: "ext4", label: "rootfs", parentPath: "/dev/fixture" },
  ]);

  const inspectorCommands = new FakeCommandHost().scriptSpawnResult({
    output: [{ data: Buffer.from(JSON.stringify({ blockdevices: [] })), stream: "stdout" }],
    result: { exitCode: 0, reason: "exit", signal: null },
  });
  await new CommandImagePartitionInspector(inspectorCommands).inspect(
    "/dev/fixture",
    new globalThis.AbortController().signal,
  );
  assert.deepEqual(inspectorCommands.spawnCalls[0].arguments, [
    "--json", "--paths", "--tree", "--output", "PATH,PKNAME,TYPE,FSTYPE,LABEL", "--", "/dev/fixture",
  ]);
  assert.equal(inspectorCommands.spawnCalls[0].timeoutMs, 5_000);

  const commands = new FakeCommandHost();
  for (let index = 0; index < 4; index += 1) commands.scriptSpawnResult({
    result: { exitCode: 0, reason: "exit", signal: null },
  });
  const mountHost = new CommandImageMountHost(commands);
  const checker = new CommandImageFilesystemChecker(commands);
  const boot = { devicePath: "/dev/fixture1", filesystem: "fat32", label: "bootfs", role: "boot" };
  const root = { devicePath: "/dev/fixture2", filesystem: "ext4", label: "rootfs", role: "root" };
  const cancellation = new globalThis.AbortController().signal;
  await mountHost.mount(boot, "/private/boot", cancellation);
  await mountHost.unmount("/private/boot", cancellation);
  await checker.check(boot, cancellation);
  await checker.check(root, cancellation);
  assert.deepEqual(commands.spawnCalls[0].arguments, [
    "--types", "vfat", "--options", "uid=0,gid=0,fmask=0177,dmask=0077,nodev,nosuid,noexec",
    "--source", "/dev/fixture1", "--target", "/private/boot",
  ]);
  assert.deepEqual(commands.spawnCalls[2].arguments, ["-n", "/dev/fixture1"]);
  assert.deepEqual(commands.spawnCalls[3].arguments, ["-f", "-n", "/dev/fixture2"]);
});

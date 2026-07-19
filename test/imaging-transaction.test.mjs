import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  confirmImageTargetPlan,
  DriveGuardrailError,
  prepareImageTargetPlan,
} from "@agent-boot/cli";
import {
  CommandDescendantUnmounter,
  FileDeviceOperationLocker,
  ImageWriteError,
  writeImageTransaction,
} from "@agent-boot/cli/imaging";
import { FakeCommandHost } from "@agent-boot/process";

const stableTarget = "/dev/disk/by-id/fixture-write-target";
const expectedByteLength = 8;
const imageSource = {
  open: () => ({
    cancel: () => undefined,
    chunks: (async function* () { yield new Uint8Array(expectedByteLength); })(),
    completion: Promise.resolve(),
  }),
};

const targetDevice = overrides => ({
  canonicalPath: "/fixture/target",
  kernelName: "fixture-target",
  model: "Fixture Media",
  mountpoints: [],
  parentKernelNames: [],
  removable: true,
  serial: "FIXTURE-SERIAL",
  sizeBytes: 1024,
  transport: "usb",
  type: "disk",
  ...overrides,
});

const rootDevice = {
  canonicalPath: "/fixture/root",
  kernelName: "fixture-root",
  model: "Fixture Root",
  mountpoints: ["/"],
  parentKernelNames: [],
  removable: false,
  serial: "ROOT-SERIAL",
  sizeBytes: 4096,
  transport: "nvme",
  type: "disk",
};

const snapshot = ({ mounts = [], targetOverrides = {} } = {}) => ({
  devices: [
    rootDevice,
    targetDevice(targetOverrides),
    ...(mounts.length === 0 ? [] : [{
      canonicalPath: "/fixture/target-partition",
      kernelName: "fixture-target1",
      mountpoints: mounts,
      parentKernelNames: ["fixture-target"],
      removable: true,
      sizeBytes: 512,
      type: "part",
    }]),
  ],
  stableLinks: [{ path: stableTarget, resolvedPath: "/fixture/target" }],
});

const request = {
  constraints: {
    expectedModel: "Fixture Media",
    expectedRemovable: true,
    expectedSerial: "FIXTURE-SERIAL",
    expectedTransport: "usb",
    maxSizeBytes: 2048,
  },
  stableTarget,
};

const confirmedPlan = async () => confirmImageTargetPlan(
  await prepareImageTargetPlan(request, { inspect: async () => snapshot() }),
  { acknowledgement: { yes: true }, writeLine: () => undefined },
);

const fakeTransaction = ({
  cancellation,
  inspect,
  onUnmount,
  onVerify,
  onWrite,
  signalSource,
} = {}) => {
  const events = [];
  let locked = false;
  const dependencies = {
    inspector: {
      inspect: async () => {
        assert.equal(locked, true, "every transaction identity check must run under the lock");
        return await inspect?.() ?? snapshot();
      },
    },
    locker: {
      acquire: async target => {
        assert.equal(target.resolvedTarget, "/fixture/target");
        events.push("lock");
        locked = true;
        return {
          release: async () => {
            events.push("release");
            locked = false;
          },
        };
      },
    },
    signalSource,
    unmounter: {
      unmount: async (mountpoint, signal) => {
        assert.equal(locked, true);
        events.push(`unmount:${mountpoint}`);
        await onUnmount?.(mountpoint, signal);
      },
    },
    verifier: {
      verify: async options => {
        assert.equal(locked, true);
        assert.equal(options.targetPath, "/fixture/target");
        events.push("verify");
        return await onVerify?.(options) ?? expectedByteLength;
      },
    },
    writer: {
      write: async options => {
        assert.equal(locked, true);
        assert.equal(options.targetPath, "/fixture/target");
        events.push("write");
        return await onWrite?.(options) ?? expectedByteLength;
      },
    },
  };
  const run = plan => writeImageTransaction({
    cancellation,
    expectedByteLength,
    plan,
    source: imageSource,
  }, dependencies);
  return { events, run };
};

const assertImagingError = async (promise, code) => {
  await assert.rejects(promise, error => {
    assert.ok(error instanceof ImageWriteError);
    assert.equal(error.code, code);
    return true;
  });
};

test("transaction locks, rechecks, narrowly unmounts, writes, verifies, and cleans up", async () => {
  const plan = await confirmedPlan();
  const mounts = new Set(["/media/fixture", "/media/fixture/nested"]);
  const transaction = fakeTransaction({
    inspect: async () => snapshot({ mounts: [...mounts] }),
    onUnmount: async mountpoint => { mounts.delete(mountpoint); },
  });

  const result = await transaction.run(plan);
  assert.equal(result.bytesWritten, expectedByteLength);
  assert.equal(result.bytesVerified, expectedByteLength);
  assert.deepEqual(transaction.events, [
    "lock",
    "unmount:/media/fixture/nested",
    "unmount:/media/fixture",
    "write",
    "verify",
    "release",
  ]);
  assert.deepEqual([...mounts], []);
});

test("identity change under the device lock aborts before every destructive adapter", async () => {
  const plan = await confirmedPlan();
  const transaction = fakeTransaction({
    inspect: async () => snapshot({ targetOverrides: { sizeBytes: 1023 } }),
  });

  await assert.rejects(transaction.run(plan), error => {
    assert.ok(error instanceof DriveGuardrailError);
    assert.equal(error.code, "identity-changed");
    return true;
  });
  assert.deepEqual(transaction.events, ["lock", "release"]);
});

test("unmount failure aborts before write and cleanup retries before releasing the lock", async () => {
  const plan = await confirmedPlan();
  const mounts = new Set(["/media/fixture"]);
  let attempts = 0;
  const transaction = fakeTransaction({
    inspect: async () => snapshot({ mounts: [...mounts] }),
    onUnmount: async mountpoint => {
      attempts += 1;
      if (attempts === 1) throw new ImageWriteError("unmount-failed", "fixture failure");
      mounts.delete(mountpoint);
    },
  });

  await assertImagingError(transaction.run(plan), "unmount-failed");
  assert.deepEqual(transaction.events, [
    "lock",
    "unmount:/media/fixture",
    "unmount:/media/fixture",
    "release",
  ]);
  assert.deepEqual([...mounts], []);
});

test("read-back mismatch is terminal and verification cannot be disabled", async () => {
  const plan = await confirmedPlan();
  const transaction = fakeTransaction({
    onVerify: async () => {
      throw new ImageWriteError("read-back-mismatch", "fixture mismatch");
    },
  });

  await assertImagingError(transaction.run(plan), "read-back-mismatch");
  assert.deepEqual(transaction.events, ["lock", "write", "verify", "release"]);
});

test("lock contention and lock-phase cancellation are terminal and release cleanly", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-boot-device-lock-"));
  const target = {
    resolvedTarget: "/fixture/target",
    sizeBytes: 1024,
    stableTarget,
  };
  try {
    const firstLocker = new FileDeviceOperationLocker({
      lockDirectory: root,
      pollMs: 2,
      timeoutMs: 100,
    });
    const held = await firstLocker.acquire(target, new globalThis.AbortController().signal);
    await assertImagingError(new FileDeviceOperationLocker({
      lockDirectory: root,
      pollMs: 2,
      timeoutMs: 10,
    }).acquire(target, new globalThis.AbortController().signal), "lock-contention");

    const cancellation = new globalThis.AbortController();
    const waiting = firstLocker.acquire(target, cancellation.signal);
    cancellation.abort();
    await assertImagingError(waiting, "canceled");
    await held.release();
    const acquiredAgain = await firstLocker.acquire(
      target,
      new globalThis.AbortController().signal,
    );
    await acquiredAgain.release();
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("cancellation at recheck, unmount, write, and verify never reports success", async () => {
  for (const phase of ["recheck", "unmount", "write", "verify"]) {
    const plan = await confirmedPlan();
    const cancellation = new globalThis.AbortController();
    const mounts = new Set(phase === "unmount" ? ["/media/fixture"] : []);
    let inspectCalls = 0;
    const transaction = fakeTransaction({
      cancellation: cancellation.signal,
      inspect: async () => {
        inspectCalls += 1;
        if (phase === "recheck" && inspectCalls === 1) cancellation.abort();
        return snapshot({ mounts: [...mounts] });
      },
      onUnmount: async mountpoint => {
        if (phase === "unmount") cancellation.abort();
        mounts.delete(mountpoint);
      },
      onVerify: async ({ cancellation: signal }) => {
        if (phase === "verify") cancellation.abort();
        if (signal.aborted) throw new ImageWriteError("canceled", "fixture cancellation");
        return expectedByteLength;
      },
      onWrite: async ({ cancellation: signal }) => {
        if (phase === "write") cancellation.abort();
        if (signal.aborted) throw new ImageWriteError("canceled", "fixture cancellation");
        return expectedByteLength;
      },
    });

    await assertImagingError(transaction.run(plan), "canceled");
    assert.equal(transaction.events.at(-1), "release");
    assert.deepEqual([...mounts], []);
  }
});

test("SIGTERM cancellation reaches the active phase and removes signal listeners", async () => {
  const plan = await confirmedPlan();
  const listeners = new Map();
  const signalSource = {
    off: (signal, listener) => { listeners.get(signal)?.delete(listener); },
    on: (signal, listener) => {
      const entries = listeners.get(signal) ?? new Set();
      entries.add(listener);
      listeners.set(signal, entries);
    },
  };
  const transaction = fakeTransaction({
    onWrite: async ({ cancellation }) => {
      for (const listener of listeners.get("SIGTERM")) listener();
      if (cancellation.aborted) throw new ImageWriteError("canceled", "fixture signal");
      return expectedByteLength;
    },
    signalSource,
  });

  await assertImagingError(transaction.run(plan), "canceled");
  assert.ok([...listeners.values()].every(entries => entries.size === 0));
  assert.equal(transaction.events.at(-1), "release");
});

test("command unmount adapter uses one managed, cancellable process and awaits completion", async () => {
  const host = new FakeCommandHost().scriptSpawnResult({
    result: { exitCode: 0, reason: "exit", signal: null },
  });
  await new CommandDescendantUnmounter(host).unmount(
    "/fixture/media",
    new globalThis.AbortController().signal,
  );

  assert.equal(host.spawnCalls.length, 1);
  assert.equal(host.spawnCalls[0].executable, "umount");
  assert.deepEqual(host.spawnCalls[0].arguments, ["--", "/fixture/media"]);
  assert.deepEqual(host.spawnCalls[0].lifetime, { policy: "managed" });
});

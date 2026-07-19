import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { TextEncoder } from "node:util";
import { URL } from "node:url";

import {
  DriveGuardrailError,
  confirmImageTargetPlan,
  formatDriveCandidates,
  formatImageTargetPlan,
  listDriveCandidates,
  prepareImageTargetPlan,
  runCreateAgent,
  runGuardedImageTarget,
  withRecheckedImageTarget,
} from "../packages/cli/dist/index.js";
import {
  LinuxDriveInspector,
  parseLsblkJson,
} from "../packages/os-linux/dist/index.js";
import { FakeCommandHost } from "../packages/process/dist/index.js";

const fixtureUrl = new URL(
  "../packages/os-linux/fixtures/lsblk/topology-matrix.json",
  import.meta.url,
);
const fixtureSource = await readFile(fixtureUrl, "utf8");
const devices = parseLsblkJson(fixtureSource);

const stableTarget = "/dev/disk/by-id/wwn-fixture-target";
const partitionTarget = "/dev/disk/by-id/usb-fixture-part1";
const rootTarget = "/dev/disk/by-id/nvme-fixture-root";
const mountedTarget = "/dev/disk/by-id/usb-fixture-mounted";

const snapshot = (overrides = {}) => ({
  devices,
  stableLinks: [
    { path: stableTarget, resolvedPath: "/dev/sdb" },
    { path: partitionTarget, resolvedPath: "/dev/sdb1" },
    { path: rootTarget, resolvedPath: "/dev/nvme0n1" },
    { path: mountedTarget, resolvedPath: "/dev/sdc" },
  ],
  ...overrides,
});

const constraints = (overrides = {}) => ({
  expectedModel: "Fixture USB",
  expectedRemovable: true,
  expectedSerial: "SERIAL-SENSITIVE",
  expectedTransport: "usb",
  maxSizeBytes: 32 * 1024 ** 3,
  ...overrides,
});

const request = (overrides = {}) => ({
  constraints: constraints(),
  stableTarget,
  ...overrides,
});

const scriptedInspector = (...snapshots) => {
  let index = 0;
  return {
    calls: 0,
    inspect: async () => {
      const value = snapshots[Math.min(index, snapshots.length - 1)];
      index += 1;
      if (value === undefined) throw new Error("Missing scripted drive snapshot");
      return value;
    },
    get count() { return index; },
  };
};

const destructiveFake = () => {
  const calls = { customize: 0, lock: 0, unmount: 0, write: 0 };
  return {
    calls,
    begin: async () => {
      calls.lock += 1;
      calls.unmount += 1;
      calls.write += 1;
      calls.customize += 1;
      return "completed";
    },
  };
};

const assertGuardrail = async (promise, code) => {
  await assert.rejects(promise, (error) => {
    assert.ok(error instanceof DriveGuardrailError);
    assert.equal(error.code, code);
    return true;
  });
};

test("recorded lsblk topology parses disks, partitions, mapper ancestry, and mounts", () => {
  assert.equal(devices.length, 8);
  assert.deepEqual(
    devices.map(({ kernelName, parentKernelName, type }) => ({
      kernelName,
      parentKernelName,
      type,
    })),
    [
      { kernelName: "nvme0n1", parentKernelName: undefined, type: "disk" },
      { kernelName: "nvme0n1p2", parentKernelName: "nvme0n1", type: "part" },
      { kernelName: "dm-0", parentKernelName: "nvme0n1p2", type: "crypt" },
      { kernelName: "sdb", parentKernelName: undefined, type: "disk" },
      { kernelName: "sdb1", parentKernelName: "sdb", type: "part" },
      { kernelName: "sdc", parentKernelName: undefined, type: "disk" },
      { kernelName: "sdc1", parentKernelName: "sdc", type: "part" },
      { kernelName: "loop0", parentKernelName: undefined, type: "loop" },
    ],
  );
  assert.deepEqual(devices.find(({ kernelName }) => kernelName === "dm-0")?.mountpoints, ["/"]);
  assert.throws(() => parseLsblkJson("not-json"), /could not be parsed/u);
});

test("Linux inspector uses injected process and filesystem adapters only", async () => {
  const host = new FakeCommandHost().scriptSpawnResult({
    output: [{ data: new TextEncoder().encode(fixtureSource), stream: "stdout" }],
    result: { exitCode: 0, reason: "exit", signal: null },
  });
  const filesystemCalls = [];
  const inspector = new LinuxDriveInspector(host, {
    filesystem: {
      list: async (path) => {
        filesystemCalls.push(["list", path]);
        return [{ isSymbolicLink: true, name: "wwn-fixture-target" }];
      },
      realpath: async (path) => {
        filesystemCalls.push(["realpath", path]);
        return "/dev/sdb";
      },
    },
    platform: "linux",
  });

  const inspected = await inspector.inspect();
  assert.equal(host.spawnCalls.length, 1);
  assert.equal(host.spawnCalls[0].executable, "lsblk");
  assert.deepEqual(filesystemCalls, [
    ["list", "/dev/disk/by-id"],
    ["realpath", stableTarget],
  ]);
  assert.deepEqual(inspected.stableLinks, [{ path: stableTarget, resolvedPath: "/dev/sdb" }]);

  const unsupportedHost = new FakeCommandHost();
  await assert.rejects(
    new LinuxDriveInspector(unsupportedHost, { platform: "darwin" }).inspect(),
    /requires a Linux imaging host/u,
  );
  assert.equal(unsupportedHost.spawnCalls.length, 0);
});

test("drives list shows whole disks and stable targets without serial or mount-path fields", async () => {
  const candidates = listDriveCandidates(snapshot());
  assert.equal(candidates.length, 3);
  assert.ok(candidates.every(({ canonicalPath }) => canonicalPath !== "/dev/sdb1"));
  const output = formatDriveCandidates(candidates).join("\n");
  assert.match(output, new RegExp(stableTarget, "u"));
  assert.match(output, /serial: \[redacted\]/u);
  assert.match(output, /active system disk/u);
  assert.match(output, /mounted descendants/u);
  assert.doesNotMatch(output, /SERIAL-SENSITIVE|ROOT-SERIAL|MOUNTED-SERIAL/u);
  assert.doesNotMatch(output, /private-fixture-path/u);

  const stdout = [];
  const exitCode = await runCreateAgent(["drives", "list"], {
    stderr: () => assert.fail("drives list should not write stderr"),
    stdout: (line) => { stdout.push(line); },
  }, { driveInspector: scriptedInspector(snapshot()) });
  assert.equal(exitCode, 0);
  assert.match(stdout.join("\n"), /stable target/u);
});

test("image preflight resolves a stable whole disk and formats a redacted plan", async () => {
  const plan = await prepareImageTargetPlan(request(), scriptedInspector(snapshot()));
  const output = formatImageTargetPlan(plan).join("\n");

  assert.equal(plan.resolvedTarget, "/dev/sdb");
  assert.equal(plan.confirmationToken.length, 12);
  assert.match(output, /resolved whole disk: \/dev\/sdb/u);
  assert.match(output, /serial: \[redacted\]/u);
  assert.doesNotMatch(output, /SERIAL-SENSITIVE|Fixture USB|wwn-fixture-target/u);
});

test("every preflight rejection leaves destructive adapters untouched", async () => {
  const modifiedTarget = (changes) => snapshot({
    devices: devices.map((device) => device.kernelName === "sdb" ? { ...device, ...changes } : device),
  });
  const cases = [
    [request(), snapshot({
      devices: devices.map((device) => ({
        ...device,
        mountpoints: device.mountpoints.filter((mountpoint) => mountpoint !== "/"),
      })),
    }), "active-root-unresolved"],
    [request({ stableTarget: "/dev/sdb" }), snapshot(), "unstable-target"],
    [request({ stableTarget: "/dev/disk/by-id/missing" }), snapshot(), "target-not-found"],
    [request({ stableTarget: partitionTarget }), snapshot(), "not-whole-disk"],
    [request(), snapshot({
      devices: devices.map((device) => device.kernelName === "sdb"
        ? { ...device, mountpoints: ["/"] }
        : device),
    }), "active-system-disk"],
    [request({
      constraints: constraints({
        expectedModel: "System NVMe",
        expectedSerial: "ROOT-SERIAL",
        expectedTransport: "nvme",
        maxSizeBytes: 512 * 1024 ** 3,
      }),
      stableTarget: rootTarget,
    }), snapshot(), "active-system-disk"],
    [request({
      constraints: constraints({
        expectedModel: "Mounted USB",
        expectedSerial: "MOUNTED-SERIAL",
      }),
      stableTarget: mountedTarget,
    }), snapshot(), "descendant-mounted"],
    [request({ constraints: constraints({ expectedModel: "Wrong model" }) }), snapshot(), "model-mismatch"],
    [request({ constraints: constraints({ expectedSerial: "Wrong serial" }) }), snapshot(), "serial-mismatch"],
    [request(), modifiedTarget({ removable: false }), "not-removable"],
    [request({ constraints: constraints({ expectedTransport: "sata" }) }), snapshot(), "transport-mismatch"],
    [request({ constraints: constraints({ maxSizeBytes: 1024 }) }), snapshot(), "size-limit-exceeded"],
  ];

  for (const [targetRequest, targetSnapshot, code] of cases) {
    const destructive = destructiveFake();
    await assertGuardrail(
      runGuardedImageTarget(
        targetRequest,
        scriptedInspector(targetSnapshot),
        { acknowledgement: { yes: true }, writeLine: () => undefined },
        destructive.begin,
      ),
      code,
    );
    assert.deepEqual(destructive.calls, { customize: 0, lock: 0, unmount: 0, write: 0 });
  }
});

test("unresolved active-root ancestry fails closed before destructive adapters", async () => {
  const cases = [
    snapshot({
      devices: devices.map((device) => device.kernelName === "dm-0"
        ? { ...device, parentKernelName: "missing-root-parent" }
        : device),
    }),
    snapshot({
      devices: devices.map((device) => device.kernelName === "nvme0n1p2"
        ? { ...device, parentKernelName: "dm-0" }
        : device),
    }),
  ];

  for (const targetSnapshot of cases) {
    assert.ok(listDriveCandidates(targetSnapshot).every(({ safetyWarnings }) =>
      safetyWarnings.includes("active root ancestry unresolved")));
    const destructive = destructiveFake();
    await assertGuardrail(
      runGuardedImageTarget(
        request(),
        scriptedInspector(targetSnapshot),
        { acknowledgement: { yes: true }, writeLine: () => undefined },
        destructive.begin,
      ),
      "active-root-unresolved",
    );
    assert.deepEqual(destructive.calls, { customize: 0, lock: 0, unmount: 0, write: 0 });
  }
});

test("confirmation prints the plan first and requires the exact acknowledgement", async () => {
  const plan = await prepareImageTargetPlan(request(), scriptedInspector(snapshot()));
  const events = [];
  const confirmed = await confirmImageTargetPlan(plan, {
    acknowledgement: {
      yes: false,
      request: async (prompt) => {
        events.push(`prompt:${prompt}`);
        return `ERASE ${plan.confirmationToken}`;
      },
    },
    writeLine: (line) => { events.push(`line:${line}`); },
  });

  assert.equal(confirmed, plan);
  assert.match(events.at(-1), /^prompt:/u);
  assert.ok(events.slice(0, -1).every((event) => event.startsWith("line:")));

  const rejectedPlan = await prepareImageTargetPlan(request(), scriptedInspector(snapshot()));
  await assertGuardrail(confirmImageTargetPlan(rejectedPlan, {
    acknowledgement: { yes: false, request: async () => "erase" },
    writeLine: () => undefined,
  }), "confirmation-rejected");
});

test("--yes still requires explicit stable identity constraints", async () => {
  const malformedConstraints = [
    { ...constraints(), expectedModel: "" },
    { ...constraints(), expectedRemovable: false },
    { ...constraints(), expectedSerial: "" },
    { ...constraints(), expectedTransport: "" },
    { ...constraints(), maxSizeBytes: 0 },
  ];
  for (const targetConstraints of malformedConstraints) {
    const destructive = destructiveFake();
    await assertGuardrail(runGuardedImageTarget(
      request({ constraints: targetConstraints }),
      scriptedInspector(snapshot()),
      { acknowledgement: { yes: true }, writeLine: () => undefined },
      destructive.begin,
    ), "invalid-constraints");
    assert.deepEqual(destructive.calls, { customize: 0, lock: 0, unmount: 0, write: 0 });
  }
});

test("TOCTOU-sensitive identity is rechecked immediately before the lock boundary", async () => {
  const changed = snapshot({
    devices: devices.map((device) => device.kernelName === "sdb"
      ? { ...device, sizeBytes: device.sizeBytes - 4096 }
      : device),
  });
  const plan = await prepareImageTargetPlan(request(), scriptedInspector(snapshot()));
  const confirmed = await confirmImageTargetPlan(plan, {
    acknowledgement: { yes: true },
    writeLine: () => undefined,
  });
  const destructive = destructiveFake();
  await assertGuardrail(
    withRecheckedImageTarget(confirmed, scriptedInspector(changed), destructive.begin),
    "identity-changed",
  );
  assert.deepEqual(destructive.calls, { customize: 0, lock: 0, unmount: 0, write: 0 });

  const events = [];
  const inspector = {
    inspect: async () => {
      events.push("inspect");
      return snapshot();
    },
  };
  const result = await runGuardedImageTarget(
    request(),
    inspector,
    { acknowledgement: { yes: true }, writeLine: () => { events.push("plan"); } },
    async () => {
      events.push("lock");
      return "authorized";
    },
  );
  assert.equal(result, "authorized");
  assert.deepEqual(events.filter((event) => event === "inspect"), ["inspect", "inspect"]);
  assert.deepEqual(events.slice(-2), ["inspect", "lock"]);
});

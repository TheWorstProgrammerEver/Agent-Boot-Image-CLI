import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { PassThrough } from "node:stream";
import test from "node:test";
import { URL } from "node:url";

import {
  IMAGE_EXIT_CODE,
  ImageWorkflowError,
  confirmImageTargetPlan,
  runCreateAgent,
  runImageCommand,
  runImageWorkflow,
} from "@agent-boot/cli";
import { ImageCustomizationError } from "@agent-boot/cli/customize";
import { ImageWriteError } from "@agent-boot/cli/imaging";
import { FakeCommandHost } from "@agent-boot/process";
import {
  requestImageTargetAcknowledgement,
} from "../packages/cli/dist/image/live.js";
import { XzRawImagePreparer } from "../packages/cli/dist/image/raw-image.js";
import { createDefinitionFixture } from "../test-support/cli-definition-fixtures.mjs";
import { createAdapterFixture } from "../test-support/raspberry-pi-os-adapter-helpers.mjs";

const stableTarget = "/dev/disk/by-id/fixture-image-target";
const secretMarker = "fixture-image-secret-must-not-appear";
const osLock = JSON.parse(await readFile(new URL(
  "../packages/os-adapters/fixtures/raspberry-pi-os-lite-trixie-arm64.os-lock.json",
  import.meta.url,
), "utf8"));

const definition = {
  account: { username: "my-user" },
  agent: { displayName: "My Agent", id: "my-agent" },
  assets: [],
  definitionUrl: "file:///fixture/agent.ts",
  network: undefined,
  operatingSystem: {
    catalogId: osLock.catalogId,
    compatibility: { architecture: "arm64", boards: ["raspberry-pi-5"] },
  },
  prompts: [],
  providers: [],
  schemaVersion: 1,
  scripts: [],
  secrets: [],
  steps: [],
};

const rootDevice = {
  canonicalPath: "/fixture/root",
  kernelName: "fixture-root",
  model: "Fixture Root",
  mountpoints: ["/"],
  parentKernelNames: [],
  removable: false,
  serial: "ROOT-SERIAL",
  sizeBytes: 1024,
  transport: "nvme",
  type: "disk",
};

const targetDevice = {
  canonicalPath: "/fixture/target",
  kernelName: "fixture-target",
  model: "Fixture Media",
  mountpoints: [],
  parentKernelNames: [],
  removable: true,
  serial: secretMarker,
  sizeBytes: 4096,
  transport: "usb",
  type: "disk",
};

const driveSnapshot = {
  devices: [rootDevice, targetDevice],
  stableLinks: [{ path: stableTarget, resolvedPath: targetDevice.canonicalPath }],
};

const request = (overrides = {}) => ({
  cacheDirectory: "/fixture/cache",
  definitionPath: "/fixture/agent.ts",
  dryRun: false,
  expectedModel: targetDevice.model,
  expectedSerial: targetDevice.serial,
  expectedTransport: targetDevice.transport,
  lockDirectory: "/fixture/locks",
  maxSizeBytes: targetDevice.sizeBytes,
  runnerBundleDirectory: "/fixture/bundle",
  runnerEntrypointPath: "/fixture/runner.mjs",
  runnerRuntimePath: "/fixture/node",
  stableTarget,
  yes: true,
  ...overrides,
});

const argumentsFor = (...extra) => [
  "--definition", "/fixture/agent.ts",
  "--runner-runtime", "/fixture/node",
  "--runner-entrypoint", "/fixture/runner.mjs",
  "--runner-bundle", "/fixture/bundle",
  "--cache-directory", "/fixture/cache",
  "--lock-directory", "/fixture/locks",
  "--target", stableTarget,
  "--expect-model", targetDevice.model,
  "--expect-serial", targetDevice.serial,
  "--expect-transport", targetDevice.transport,
  "--max-size-bytes", String(targetDevice.sizeBytes),
  "--yes",
  ...extra,
];

const imageSource = {
  open: () => ({
    cancel: () => undefined,
    chunks: (async function* () { yield new Uint8Array(16); })(),
    completion: Promise.resolve(),
  }),
};

const createHarness = ({ failAt, releaseFailure = false, signalAt } = {}) => {
  const events = [];
  const stdout = [];
  const stderr = [];
  const signals = new EventEmitter();
  const secretBytes = Buffer.from(secretMarker);
  const maybeInterrupt = name => {
    if (signalAt === name) signals.emit("SIGTERM");
    if (failAt === name) throw new Error(`injected ${name} failure with ${secretMarker}`);
  };
  const workspace = {
    assemblyDirectory: "/fixture/workspace/assembly",
    path: "/fixture/workspace",
    remove: async () => {
      events.push("cleanup");
      maybeInterrupt("cleanup");
    },
  };
  const dependencies = {
    acquireArtifact: async () => {
      events.push("artifact");
      maybeInterrupt("artifact");
      return {
        compressedByteLength: 8,
        compressionFormat: "xz",
        imageByteLength: 16,
        imageFormat: "raw",
        path: "/fixture/artifact.img.xz",
        sha256: "a".repeat(64),
        source: "cache",
      };
    },
    confirmTarget: async (plan, _request, io) => {
      assert.match(io.stdout === undefined ? "" : stdout.join("\n"), /guardrail overrides: none/u);
      events.push("confirm");
      maybeInterrupt("confirm");
      return confirmImageTargetPlan(plan, {
        acknowledgement: { yes: true },
        writeLine: io.stdout,
      });
    },
    createWorkspace: async () => {
      events.push("workspace");
      maybeInterrupt("workspace");
      return workspace;
    },
    customizeImage: async input => {
      events.push("customize");
      if (failAt === "customize") throw new ImageCustomizationError("adapter-failed");
      maybeInterrupt("customize");
      input.cancellation.throwIfAborted();
      events.push("check");
      if (failAt === "check") throw new ImageCustomizationError("filesystem-check-failed");
      maybeInterrupt("check");
      input.cancellation.throwIfAborted();
      return { filesystemChecks: [{ status: "passed" }, { status: "passed" }] };
    },
    driveInspector: {
      inspect: async () => {
        events.push("preflight");
        maybeInterrupt("preflight");
        return driveSnapshot;
      },
    },
    loadBootstrapSecrets: async () => {
      events.push("secrets");
      maybeInterrupt("secrets");
      return new Map([["credential", secretBytes]]);
    },
    loadDefinition: async () => {
      events.push("load");
      maybeInterrupt("load");
      return { definition };
    },
    prepareImageSource: async () => {
      events.push("prepare-source");
      maybeInterrupt("prepare-source");
      return { source: imageSource };
    },
    publishAssembly: async () => {
      events.push("publish");
      maybeInterrupt("publish");
    },
    readRunnerArtifacts: async () => {
      events.push("runner-artifacts");
      maybeInterrupt("runner-artifacts");
      return { entrypoint: Buffer.from("entrypoint"), runtime: Buffer.from("runtime") };
    },
    resolveOsLock: () => {
      events.push("resolve-os");
      maybeInterrupt("resolve-os");
      return osLock;
    },
    signalSource: signals,
    synthesize: async () => {
      events.push("synthesize");
      maybeInterrupt("synthesize");
      return { assemblyId: "assembly-fixture", copied: {}, documents: {}, files: [] };
    },
    verifyRunnerBundle: async () => {
      events.push("verify-bundle");
      maybeInterrupt("verify-bundle");
    },
    writeImage: async input => {
      events.push("lock");
      if (failAt === "lock") throw new ImageWriteError("lock-failed", "fixture");
      maybeInterrupt("lock");
      let operationError;
      let completedPhase;
      try {
        input.cancellation.throwIfAborted();
        events.push("recheck");
        input.onProgress({ completed: 0, phase: "unmount", total: 0, unit: "mounts" });
        if (failAt === "recheck") throw new ImageWriteError("unmount-failed", "fixture");
        maybeInterrupt("recheck");
        input.cancellation.throwIfAborted();
        events.push("write");
        input.onProgress({ completed: 16, phase: "write", total: 16, unit: "bytes" });
        if (failAt === "write") throw new ImageWriteError("short-write", "fixture");
        maybeInterrupt("write");
        input.cancellation.throwIfAborted();
        events.push("verify");
        input.onProgress({ completed: 16, phase: "verify", total: 16, unit: "bytes" });
        if (failAt === "verify") throw new ImageWriteError("read-back-mismatch", "fixture");
        maybeInterrupt("verify");
        input.cancellation.throwIfAborted();
        completedPhase = "verify";
        const afterVerifyResult = await input.afterVerify({
          cancellation: input.cancellation,
          target: { resolvedTarget: targetDevice.canonicalPath },
        });
        input.cancellation.throwIfAborted();
        if (!releaseFailure) {
          return {
            afterVerifyResult,
            bytesVerified: 16,
            target: { resolvedTarget: targetDevice.canonicalPath },
          };
        }
      } catch (error) {
        operationError = error;
        if (!releaseFailure) throw error;
      } finally {
        events.push("release");
      }
      throw new ImageWriteError("cleanup-failed", "fixture target release failed", {
        cause: new AggregateError(operationError === undefined
          ? [new Error("fixture release failure")]
          : [operationError, new Error("fixture release failure")]),
        cleanupOnly: operationError === undefined,
        ...(completedPhase === undefined ? {} : { completedPhase }),
      });
    },
  };
  const io = {
    stderr: line => { stderr.push(line); },
    stdout: line => { stdout.push(line); },
  };
  return { dependencies, events, io, secretBytes, stderr, stdout };
};

test("image workflow executes the exact guarded order and reports only redacted identities", async () => {
  const harness = createHarness();
  const result = await runImageWorkflow(request(), harness.io, harness.dependencies);

  assert.deepEqual(harness.events, [
    "load", "resolve-os", "runner-artifacts", "verify-bundle", "synthesize", "secrets",
    "artifact", "workspace", "publish", "prepare-source", "preflight", "confirm",
    "lock", "recheck", "write", "verify", "customize", "check", "release", "cleanup",
  ]);
  assert.equal(result.targetVerification, "read-back-passed");
  assert.equal(result.filesystemCheckCount, 2);
  assert.deepEqual(harness.secretBytes, Buffer.alloc(harness.secretBytes.length));
  const output = harness.stdout.join("\n");
  assert.match(output, /assembly-fixture|OS lock|read-back/u);
  assert.doesNotMatch(output, new RegExp(`${secretMarker}|fixture-image-target`, "u"));
});

test("every injected phase failure short-circuits later work and still cleans owned state", async t => {
  const phases = [
    "load", "resolve-os", "runner-artifacts", "verify-bundle", "synthesize", "secrets",
    "artifact", "workspace", "publish", "prepare-source", "preflight", "confirm",
    "lock", "recheck", "write", "verify", "customize", "check",
  ];
  for (const phase of phases) await t.test(phase, async () => {
    const harness = createHarness({ failAt: phase });
    await assert.rejects(
      runImageWorkflow(request(), harness.io, harness.dependencies),
      error => error instanceof ImageWorkflowError,
    );
    const failedIndex = harness.events.indexOf(phase);
    assert.notEqual(failedIndex, -1);
    const cleanupIndex = harness.events.indexOf("cleanup");
    if (harness.events.includes("workspace") && phase !== "workspace") {
      assert.equal(cleanupIndex, harness.events.length - 1);
    } else {
      assert.equal(cleanupIndex, -1);
    }
    assert.equal(harness.events.includes("check") && phase !== "check", false);
    assert.doesNotMatch(harness.stderr.join("\n"), new RegExp(secretMarker, "u"));
  });
});

test("signals at every phase short-circuit safely and remove the workspace once acquired", async t => {
  for (const phase of [
    "load", "resolve-os", "runner-artifacts", "verify-bundle", "synthesize", "secrets",
    "artifact", "workspace", "publish", "prepare-source", "preflight", "confirm",
    "lock", "recheck", "write", "verify", "customize", "check",
  ]) await t.test(phase, async () => {
    const harness = createHarness({ signalAt: phase });
    await assert.rejects(runImageWorkflow(request(), harness.io, harness.dependencies));
    assert.equal(harness.events.at(-1) === "cleanup", harness.events.includes("workspace"));
    assert.equal(harness.dependencies.signalSource.listenerCount("SIGTERM"), 0);
  });
});

test("a signal aborts pending artifact acquisition instead of waiting for it to settle", async () => {
  const harness = createHarness();
  let markStarted;
  const started = new Promise(resolve => { markStarted = resolve; });
  harness.dependencies.acquireArtifact = async (_lock, _cache, cancellation) => {
    harness.events.push("artifact");
    markStarted();
    return await new Promise((_resolve, reject) => {
      cancellation.addEventListener("abort", () => {
        reject(new Error("fixture acquisition canceled"));
      }, { once: true });
    });
  };

  const pending = runImageWorkflow(request(), harness.io, harness.dependencies);
  await started;
  harness.dependencies.signalSource.emit("SIGTERM");
  await assert.rejects(
    pending,
    error => error instanceof ImageWorkflowError && error.canceled,
  );
  assert.equal(harness.dependencies.signalSource.listenerCount("SIGTERM"), 0);
  assert.deepEqual(harness.secretBytes, Buffer.alloc(harness.secretBytes.length));
  assert.equal(harness.events.includes("workspace"), false);
});

test("a signal aborts pending interactive confirmation and cleans owned state", async () => {
  const harness = createHarness();
  let markStarted;
  const started = new Promise(resolve => { markStarted = resolve; });
  harness.dependencies.confirmTarget = async (_plan, _request, _io, cancellation) => {
    harness.events.push("confirm");
    markStarted();
    return await new Promise((_resolve, reject) => {
      cancellation.addEventListener("abort", () => {
        reject(new Error("fixture confirmation canceled"));
      }, { once: true });
    });
  };

  const pending = runImageWorkflow(request({ yes: false }), harness.io, harness.dependencies);
  await started;
  harness.dependencies.signalSource.emit("SIGINT");
  await assert.rejects(
    pending,
    error => error instanceof ImageWorkflowError && error.canceled,
  );
  assert.equal(harness.dependencies.signalSource.listenerCount("SIGINT"), 0);
  assert.deepEqual(harness.secretBytes, Buffer.alloc(harness.secretBytes.length));
  assert.equal(harness.events.at(-1), "cleanup");
  assert.equal(harness.events.includes("lock"), false);
});

test("the live acknowledgement request rejects promptly when canceled", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const cancellation = new globalThis.AbortController();
  const pending = requestImageTargetAcknowledgement(
    "Confirm fixture target",
    cancellation.signal,
    input,
    output,
  );
  cancellation.abort();
  await assert.rejects(pending, /confirmation canceled/u);
  assert.equal(input.listenerCount("data"), 0);
});

test("raw-image preparation rejects swapped artifact bytes before spawning xz", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-boot-image-prepare-"));
  const artifactPath = join(root, "cached.img.xz");
  const original = Buffer.from("pinned compressed artifact");
  const substituted = Buffer.from(original);
  substituted[0] ^= 0xff;
  const commands = new FakeCommandHost();
  try {
    await writeFile(artifactPath, substituted);
    const preparer = new XzRawImagePreparer(commands);
    await assert.rejects(
      preparer.prepare({
        compressedByteLength: original.length,
        compressionFormat: "xz",
        imageByteLength: 4096,
        imageFormat: "raw",
        path: artifactPath,
        sha256: createHash("sha256").update(original).digest("hex"),
        source: "cache",
      }, {
        assemblyDirectory: join(root, "assembly"),
        path: root,
        remove: async () => undefined,
      }, new globalThis.AbortController().signal),
      /pinned digest/u,
    );
    assert.equal(commands.spawnCalls.length, 0);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("dry-run completes validation and synthesis without reaching any live boundary", async () => {
  const harness = createHarness();
  const result = await runImageWorkflow(request({ dryRun: true }), harness.io, harness.dependencies);
  assert.equal(result.dryRun, true);
  assert.deepEqual(harness.events, [
    "load", "resolve-os", "runner-artifacts", "verify-bundle", "synthesize",
  ]);
  assert.match(harness.stdout.join("\n"), /no secrets, downloads, commands, devices/u);
});

test("cleanup failure preserves the original verification error first", async () => {
  const harness = createHarness({ failAt: "verify" });
  harness.dependencies.createWorkspace = async () => {
    harness.events.push("workspace");
    return {
      assemblyDirectory: "/fixture/workspace/assembly",
      path: "/fixture/workspace",
      remove: async () => {
        harness.events.push("cleanup");
        throw new Error("cleanup failed");
      },
    };
  };
  await assert.rejects(
    runImageWorkflow(request(), harness.io, harness.dependencies),
    error => {
      assert.ok(error instanceof ImageWorkflowError);
      assert.equal(error.phase, "verify");
      assert.equal(error.cleanupFailed, true);
      assert.ok(error.cause instanceof AggregateError);
      assert.ok(error.cause.errors[0] instanceof ImageWorkflowError);
      assert.equal(error.cause.errors[0].phase, "verify");
      assert.ok(error.cause.errors[0].cause instanceof ImageWriteError);
      return true;
    },
  );
});

test("write cleanup failures retain the primary error and verified recovery milestone", async t => {
  for (const scenario of [
    {
      failAt: "verify",
      name: "verification plus release failure",
      phase: "verify",
      recovery: "target-incomplete",
    },
    {
      name: "release-only failure after final checks",
      phase: "cleanup",
      recovery: "complete",
    },
  ]) await t.test(scenario.name, async () => {
    const harness = createHarness({ failAt: scenario.failAt, releaseFailure: true });
    await assert.rejects(
      runImageWorkflow(request(), harness.io, harness.dependencies),
      error => {
        assert.ok(error instanceof ImageWorkflowError);
        assert.equal(error.cleanupFailed, true);
        assert.equal(error.phase, scenario.phase);
        assert.equal(error.recovery, scenario.recovery);
        assert.ok(error.cause instanceof ImageWriteError);
        assert.equal(error.cause.code, "cleanup-failed");
        if (scenario.failAt === "verify") {
          assert.ok(error.cause.cause instanceof AggregateError);
          assert.ok(error.cause.cause.errors[0] instanceof ImageWriteError);
          assert.equal(error.cause.cause.errors[0].code, "read-back-mismatch");
        }
        return true;
      },
    );

    const cliHarness = createHarness({ failAt: scenario.failAt, releaseFailure: true });
    assert.equal(
      await runImageCommand(argumentsFor(), cliHarness.io, cliHarness.dependencies),
      IMAGE_EXIT_CODE.cleanupFailure,
    );
    assert.match(cliHarness.stderr.join("\n"), /cleanup is required/u);
  });
});

test("customization cleanup failures retain primary errors and completed checks", async t => {
  for (const scenario of [
    {
      error: new ImageCustomizationError("cleanup-failed", {
        cause: new AggregateError([
          new ImageCustomizationError("adapter-failed"),
          new Error("fixture unmount failure"),
        ]),
      }),
      name: "adapter plus unmount failure",
      phase: "customize",
      recovery: "target-verified-needs-customization",
    },
    {
      error: new ImageCustomizationError("cleanup-failed", {
        cause: new AggregateError([new Error("fixture mount-root removal failure")]),
        cleanupOnly: true,
        completedPhase: "check",
      }),
      name: "cleanup-only failure after filesystem checks",
      phase: "cleanup",
      recovery: "complete",
    },
  ]) await t.test(scenario.name, async () => {
    const harness = createHarness();
    harness.dependencies.customizeImage = async () => { throw scenario.error; };
    await assert.rejects(
      runImageWorkflow(request(), harness.io, harness.dependencies),
      error => {
        assert.ok(error instanceof ImageWorkflowError);
        assert.equal(error.cleanupFailed, true);
        assert.equal(error.phase, scenario.phase);
        assert.equal(error.recovery, scenario.recovery);
        if (!scenario.error.cleanupOnly) {
          assert.ok(scenario.error.cause instanceof AggregateError);
          assert.ok(scenario.error.cause.errors[0] instanceof ImageCustomizationError);
          assert.equal(scenario.error.cause.errors[0].code, "adapter-failed");
        }
        return true;
      },
    );

    const cliHarness = createHarness();
    cliHarness.dependencies.customizeImage = async () => { throw scenario.error; };
    assert.equal(
      await runImageCommand(argumentsFor(), cliHarness.io, cliHarness.dependencies),
      IMAGE_EXIT_CODE.cleanupFailure,
    );
    assert.match(cliHarness.stderr.join("\n"), /cleanup is required/u);
  });
});

test("failure recovery distinguishes untouched, incomplete, and verified media", async () => {
  for (const [phase, recovery] of [
    ["lock", "target-unchanged"],
    ["recheck", "target-unchanged"],
    ["write", "target-incomplete"],
    ["verify", "target-incomplete"],
    ["customize", "target-verified-needs-customization"],
    ["check", "target-verified-needs-customization"],
  ]) {
    const harness = createHarness({ failAt: phase });
    await assert.rejects(
      runImageWorkflow(request(), harness.io, harness.dependencies),
      error => error instanceof ImageWorkflowError && error.recovery === recovery,
    );
  }
});

test("the CLI exposes stable phase exit codes and never prints injected exception text", async t => {
  const cases = [
    ["artifact", IMAGE_EXIT_CODE.preparationFailure],
    ["preflight", IMAGE_EXIT_CODE.preflightFailure],
    ["verify", IMAGE_EXIT_CODE.writeFailure],
    ["check", IMAGE_EXIT_CODE.customizationFailure],
  ];
  for (const [phase, expected] of cases) await t.test(phase, async () => {
    const harness = createHarness({ failAt: phase });
    const exitCode = await runImageCommand(argumentsFor(), harness.io, harness.dependencies);
    assert.equal(exitCode, expected);
    const output = [...harness.stdout, ...harness.stderr].join("\n");
    assert.match(output, /recovery state/u);
    assert.doesNotMatch(output, new RegExp(secretMarker, "u"));
  });

  const cleanupHarness = createHarness();
  cleanupHarness.dependencies.createWorkspace = async () => ({
    assemblyDirectory: "/fixture/workspace/assembly",
    path: "/fixture/workspace",
    remove: async () => { throw new Error("cleanup"); },
  });
  assert.equal(
    await runImageCommand(argumentsFor(), cleanupHarness.io, cleanupHarness.dependencies),
    IMAGE_EXIT_CODE.cleanupFailure,
  );
  assert.equal(
    await runImageCommand(["--target", "/dev/sda"], cleanupHarness.io, cleanupHarness.dependencies),
    64,
  );

  const canceledHarness = createHarness({ signalAt: "artifact" });
  assert.equal(
    await runImageCommand(argumentsFor(), canceledHarness.io, canceledHarness.dependencies),
    IMAGE_EXIT_CODE.canceled,
  );
});

test("public create-agent image dispatch prints the trust warning and returns fake success", async () => {
  const harness = createHarness();
  const exitCode = await runCreateAgent(["image", ...argumentsFor()], harness.io, {
    imageWorkflow: harness.dependencies,
  });
  assert.equal(exitCode, 0);
  assert.match(harness.stderr.join("\n"), /trusted executable code/u);
  assert.match(harness.stdout.at(-1), /Image complete/u);
});

test("executable dry-run cannot reach host commands or device inspection", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-boot-image-cli-dry-run-"));
  const adapter = await createAdapterFixture();
  try {
    const fixture = await createDefinitionFixture(root, "image-dry-run");
    const runtime = join(root, "node-runtime");
    const entrypoint = join(root, "runner.mjs");
    await writeFile(runtime, "fixture runtime\n");
    await writeFile(entrypoint, "export {};\n");
    const result = spawnSync(process.execPath, [
      "packages/cli/dist/bin.js",
      "image",
      "--definition", fixture.definitionPath,
      "--runner-runtime", runtime,
      "--runner-entrypoint", entrypoint,
      "--runner-bundle", adapter.bundle,
      "--cache-directory", join(root, "cache-must-not-exist"),
      "--lock-directory", join(root, "locks-must-not-exist"),
      "--target", stableTarget,
      "--expect-model", targetDevice.model,
      "--expect-serial", targetDevice.serial,
      "--expect-transport", targetDevice.transport,
      "--max-size-bytes", String(targetDevice.sizeBytes),
      "--dry-run",
    ], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: { ...process.env, PATH: "/fixture/no-commands-available" },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Dry-run complete/u);
    assert.match(result.stderr, /trusted executable code/u);
    assert.doesNotMatch(`${result.stdout}${result.stderr}`, new RegExp(secretMarker, "u"));
  } finally {
    await Promise.all([
      adapter.cleanup(),
      rm(root, { force: true, recursive: true }),
    ]);
  }
});

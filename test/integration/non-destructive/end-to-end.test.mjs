import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { EventEmitter } from "node:events";
import {
  access,
  mkdir,
  readFile,
  rm,
  stat,
} from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";
import test from "node:test";
import { URL } from "node:url";

import {
  confirmImageTargetPlan,
  runImageWorkflow,
} from "@agent-boot/cli";
import { writeAssemblyAtomically } from "@agent-boot/assembly";
import { customizeRaspberryPiOsTrixie } from "@agent-boot/os-adapters/raspberry-pi-os-trixie";
import { verifyRunnerBundle } from "@agent-boot/runner-bundle";

import {
  createAdapterFixture,
  passwordHasher,
  snapshotTree,
} from "../../../test-support/raspberry-pi-os-adapter-helpers.mjs";
import {
  PRIVATE_MARKER,
  assemblySha256,
  createDefinitiveDefinition,
  runnerArtifacts,
  synthesizeDefinitiveAssembly,
} from "../../../test-support/non-destructive/assembly-fixture.mjs";
import { simulateRunnerReboots } from "../../../test-support/non-destructive/runner-simulation.mjs";

const golden = JSON.parse(await readFile(
  new URL("./fixtures/golden.json", import.meta.url),
  "utf8",
));
const stableTarget = "/dev/disk/by-id/non-destructive-fixture-target";
const artifactSha256 = "f".repeat(64);

const rootDevice = {
  canonicalPath: "/fixture/host-root",
  kernelName: "fixture-host-root",
  model: "Fixture Host Root",
  mountpoints: ["/"],
  parentKernelNames: [],
  removable: false,
  serial: "FIXTURE-HOST",
  sizeBytes: 1024,
  transport: "nvme",
  type: "disk",
};

const targetDevice = {
  canonicalPath: "/fixture/non-destructive-target",
  kernelName: "fixture-target",
  model: "Fixture Media",
  mountpoints: [],
  parentKernelNames: [],
  removable: true,
  serial: "FIXTURE-TARGET",
  sizeBytes: 4096,
  transport: "usb",
  type: "disk",
};

const request = definitionPath => ({
  cacheDirectory: "/fixture/cache",
  definitionPath,
  dryRun: false,
  expectedModel: targetDevice.model,
  expectedSerial: targetDevice.serial,
  expectedTransport: targetDevice.transport,
  lockDirectory: "/fixture/locks",
  maxSizeBytes: targetDevice.sizeBytes,
  runnerBundleDirectory: "/fixture/runner-bundle",
  runnerEntrypointPath: "/fixture/runner-entrypoint.mjs",
  runnerRuntimePath: "/fixture/private-node",
  stableTarget,
  yes: true,
});

const imageSource = {
  open: () => ({
    cancel: () => undefined,
    chunks: (async function* () { yield new Uint8Array(16); })(),
    completion: Promise.resolve(),
  }),
};

const absent = path => assert.rejects(access(path), error => error.code === "ENOENT");

test("definitive assembly completes through non-destructive image and reboot simulation", async () => {
  const accessAudit = globalThis.__agentBootNonDestructiveAudit;
  if (process.env.AGENT_BOOT_NON_DESTRUCTIVE_GUARD === "1") {
    assert.equal(accessAudit?.active, true);
  }
  const fixture = await createAdapterFixture();
  const workflowRoot = join(fixture.root, "workflow");
  const assemblyDirectory = join(workflowRoot, "assembly");
  const events = [];
  const stdout = [];
  const stderr = [];
  const signals = new EventEmitter();
  const boundaryAudit = {
    externalProviderCalls: 0,
    mounts: 0,
    physicalDeviceOpens: 0,
    privilegedCommands: 0,
    realAdapterInvocations: 0,
  };
  let adapterResult;
  let secretValues = [];

  try {
    const definition = await createDefinitiveDefinition(fixture.root);
    assert.equal(definition.loaded.referenceCount, 4);
    const first = await synthesizeDefinitiveAssembly(definition.loaded);
    const second = await synthesizeDefinitiveAssembly(definition.loaded);
    const firstHash = assemblySha256(first.assembly);
    const secondHash = assemblySha256(second.assembly);

    assert.equal(first.assembly.assemblyId, second.assembly.assemblyId);
    assert.equal(firstHash, secondHash);
    assert.equal(first.assembly.assemblyId, golden.assemblyId);
    assert.equal(firstHash, golden.assemblySha256);
    assert.deepEqual({
      manifest: first.assembly.documents.manifest.schemaVersion,
      osLock: first.assembly.documents.osLock.schemaVersion,
      runnerPlan: first.assembly.documents.runnerPlan.schemaVersion,
    }, golden.schemaVersions);

    const hashFixture = passwordHasher();
    const workflowResult = await runImageWorkflow(
      request(definition.definitionPath),
      {
        stderr: line => { stderr.push(line); },
        stdout: line => { stdout.push(line); },
      },
      {
        acquireArtifact: async (_lock, _cache, cancellation) => {
          cancellation.throwIfAborted();
          events.push("fake-artifact");
          return {
            compressedByteLength: 8,
            compressionFormat: "xz",
            imageByteLength: 16,
            imageFormat: "raw",
            path: "/fixture/cache/pinned.img.xz",
            sha256: artifactSha256,
            source: "cache",
          };
        },
        confirmTarget: async (plan, _request, _io, cancellation) => {
          cancellation.throwIfAborted();
          events.push("fake-confirmation");
          return confirmImageTargetPlan(plan, {
            acknowledgement: { yes: true },
            writeLine: line => { stdout.push(line); },
          });
        },
        createWorkspace: async () => {
          events.push("temporary-workspace");
          await mkdir(workflowRoot, { recursive: true });
          return {
            assemblyDirectory,
            path: workflowRoot,
            remove: async () => {
              events.push("temporary-workspace-removed");
              await rm(workflowRoot, { force: true, recursive: true });
            },
          };
        },
        customizeImage: async input => {
          input.cancellation.throwIfAborted();
          assert.equal(input.targetPath, targetDevice.canonicalPath);
          events.push("fixture-customization");
          adapterResult = await customizeRaspberryPiOsTrixie(fixture.options({
            assemblyDirectory: input.assemblyDirectory,
            bootstrapSecrets: input.bootstrapSecrets,
            passwordHasher: hashFixture.hasher,
          }));
          return { filesystemChecks: adapterResult.assertions };
        },
        driveInspector: {
          inspect: async () => {
            events.push("fake-drive-inspection");
            return {
              devices: [rootDevice, targetDevice],
              stableLinks: [{ path: stableTarget, resolvedPath: targetDevice.canonicalPath }],
            };
          },
        },
        loadBootstrapSecrets: async () => {
          events.push("fixture-secret-references");
          const secrets = new Map([
            ["account-authentication", Buffer.from(`${PRIVATE_MARKER}-account`)],
            ["network-authentication", Buffer.from(`${PRIVATE_MARKER}-wifi`)],
            ["repository-credential", Buffer.from(`${PRIVATE_MARKER}-repository-credential\n`)],
          ]);
          secretValues = [...secrets.values()];
          return secrets;
        },
        loadDefinition: async path => {
          assert.equal(path, definition.definitionPath);
          events.push("trusted-definition-validation");
          return definition.loaded;
        },
        prepareImageSource: async (_artifact, _workspace, cancellation) => {
          cancellation.throwIfAborted();
          events.push("fake-image-source");
          return { source: imageSource };
        },
        publishAssembly: async (_workspace, assembly) => {
          events.push("atomic-assembly-publication");
          await writeAssemblyAtomically(assemblyDirectory, assembly.files);
        },
        readRunnerArtifacts: async () => {
          events.push("runner-artifacts");
          return runnerArtifacts;
        },
        resolveOsLock: loadedDefinition => {
          events.push("curated-os-lock");
          assert.deepEqual(loadedDefinition, definition.loaded.definition);
          return first.osLock;
        },
        signalSource: signals,
        synthesize: async (loadedDefinition, osLock, artifacts) => {
          events.push("deterministic-synthesis");
          assert.deepEqual(loadedDefinition, definition.loaded.definition);
          assert.deepEqual(osLock, first.osLock);
          assert.deepEqual(artifacts, runnerArtifacts);
          return first.assembly;
        },
        verifyRunnerBundle: async directory => {
          events.push("runner-bundle-verification");
          assert.equal(directory, "/fixture/runner-bundle");
          await verifyRunnerBundle(fixture.bundle);
        },
        writeImage: async input => {
          input.cancellation.throwIfAborted();
          events.push("fake-write");
          input.onProgress({ bytesWritten: 16, phase: "write", totalBytes: 16 });
          events.push("fake-read-back");
          input.onProgress({ bytesVerified: 16, phase: "verify", totalBytes: 16 });
          const afterVerifyResult = await input.afterVerify({
            cancellation: input.cancellation,
            target: { resolvedTarget: targetDevice.canonicalPath },
          });
          return {
            afterVerifyResult,
            bytesVerified: 16,
            target: { resolvedTarget: targetDevice.canonicalPath },
          };
        },
      },
    );

    assert.deepEqual(workflowResult, {
      assemblyId: golden.assemblyId,
      catalogId: "raspberry-pi-os-lite-trixie-arm64-2026-06-18",
      dryRun: false,
      filesystemCheckCount: golden.requiredAssertions.length,
      osArtifactSha256: artifactSha256,
      targetBytesVerified: 16,
      targetVerification: "read-back-passed",
    });
    assert.deepEqual(
      adapterResult.assertions.map(assertion => assertion.id),
      golden.requiredAssertions,
    );
    assert.ok(secretValues.every(value => value.every(byte => byte === 0)));
    assert.equal(signals.listenerCount("SIGINT"), 0);
    assert.equal(signals.listenerCount("SIGTERM"), 0);
    assert.equal(signals.listenerCount("SIGHUP"), 0);
    await absent(workflowRoot);

    const tree = await snapshotTree(join(fixture.root, "image"));
    const targetPaths = new Set(tree.map(record => record.path));
    for (const path of golden.requiredTargetPaths) assert.ok(targetPaths.has(path), path);
    assert.equal((await stat(join(fixture.boot, "network-config"))).mode & 0o777, 0o600);
    const networkConfig = JSON.parse(await readFile(
      join(fixture.boot, "network-config"),
      "utf8",
    ));
    assert.equal(networkConfig.network.version, 2);
    assert.equal(
      networkConfig.network.wifis.wlan0["access-points"]["<network-ssid>"].password,
      `${PRIVATE_MARKER}-wifi`,
    );
    assert.match(
      await readFile(join(fixture.systemRoot, "etc", "agent-boot", "plan.json"), "utf8"),
      /"secretId": "repository-credential"/u,
    );
    assert.match(
      await readFile(
        join(fixture.systemRoot, "etc", "systemd", "system", "agent-boot-runner.service"),
        "utf8",
      ),
      /StandardInput=tty-force/u,
    );

    const runner = await simulateRunnerReboots({
      privateMarker: PRIVATE_MARKER,
      systemRoot: fixture.systemRoot,
    });
    assert.ok(runner.progress.some(event => event.status === "manual-waiting"));
    assert.ok(runner.progress.some(event => event.status === "secret-source-removed"));
    assert.ok(runner.progress.some(event => event.status === "runner-succeeded"));

    assert.deepEqual(boundaryAudit, {
      externalProviderCalls: 0,
      mounts: 0,
      physicalDeviceOpens: 0,
      privilegedCommands: 0,
      realAdapterInvocations: 0,
    });
    if (accessAudit !== undefined) assert.deepEqual(accessAudit.deviceAccessAttempts, []);
    assert.deepEqual(events, [
      "trusted-definition-validation",
      "curated-os-lock",
      "runner-artifacts",
      "runner-bundle-verification",
      "deterministic-synthesis",
      "fixture-secret-references",
      "fake-artifact",
      "temporary-workspace",
      "atomic-assembly-publication",
      "fake-image-source",
      "fake-drive-inspection",
      "fake-confirmation",
      "fake-write",
      "fake-read-back",
      "fixture-customization",
      "temporary-workspace-removed",
    ]);

    const observable = JSON.stringify({
      adapterAssertions: adapterResult.assertions,
      events,
      runnerProgress: runner.progress,
      runnerState: runner.state,
      stderr,
      stdout,
      workflowResult,
    });
    assert.doesNotMatch(observable, new RegExp(PRIVATE_MARKER, "u"));
    assert.doesNotMatch(observable, /-----BEGIN|\bgh[pousr]_|\bsk-[A-Za-z0-9]{20,}/u);
  } finally {
    await fixture.cleanup();
  }
});

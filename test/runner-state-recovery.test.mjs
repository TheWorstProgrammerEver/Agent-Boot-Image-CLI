import assert from "node:assert/strict";
import { chmod, mkdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import test from "node:test";

import {
  RUNNER_CHECKPOINT_SCHEMA_VERSION,
  RunnerStateStore,
  StateAccessError,
  UnsafeRecoveryError,
} from "@agent-boot/runner";

import {
  checkpointMode,
  createStateFixture,
  FaultInjectingStateFileSystem,
  injectedFailure,
  readCheckpoint,
  writeCheckpoint,
} from "../test-support/runner-state-helpers.mjs";

test("startup distinguishes absent and valid state with private permissions", async () => {
  const fixture = await createStateFixture();
  try {
    assert.deepEqual(await fixture.store.inspect(fixture.plan), { status: "absent" });

    const initialized = await fixture.store.initialize(fixture.plan);
    assert.equal(initialized.schemaVersion, RUNNER_CHECKPOINT_SCHEMA_VERSION);
    assert.equal(initialized.revision, 0);
    assert.equal(initialized.updatedAt, "2026-07-19T00:00:00.000Z");
    assert.deepEqual(initialized.plan, fixture.plan);
    assert.equal(await checkpointMode(fixture.path), 0o600);
    assert.equal((await stat(dirname(fixture.path))).mode & 0o777, 0o700);
    assert.equal((await fixture.store.inspect(fixture.plan)).status, "valid");
    assert.deepEqual(await fixture.store.initialize(fixture.plan), initialized);
  } finally {
    await fixture.cleanup();
  }
});

test("startup reports stale plan identity and refuses implicit replacement", async () => {
  const fixture = await createStateFixture();
  try {
    const initialized = await fixture.store.initialize(fixture.plan);
    const expectedPlan = { ...fixture.plan, planSha256: "b".repeat(64) };
    const inspection = await fixture.store.inspect(expectedPlan);

    assert.equal(inspection.status, "stale-plan");
    assert.deepEqual(inspection.recordedPlan, fixture.plan);
    await assert.rejects(fixture.store.initialize(expectedPlan), UnsafeRecoveryError);
    assert.deepEqual(await readCheckpoint(fixture.path), initialized);
  } finally {
    await fixture.cleanup();
  }
});

test("startup distinguishes incompatible, corrupt, truncated, and oversized state", async () => {
  const fixture = await createStateFixture();
  try {
    await writeCheckpoint(fixture.path, { schemaVersion: 2 });
    assert.deepEqual(await fixture.store.inspect(fixture.plan), {
      foundVersion: 2,
      status: "incompatible",
    });

    await writeCheckpoint(fixture.path, '{"schemaVersion":1');
    assert.deepEqual(await fixture.store.inspect(fixture.plan), {
      diagnostic: "state file is not valid JSON",
      status: "corrupt",
    });

    await writeCheckpoint(fixture.path, { schemaVersion: 1, secretValue: "must-not-surface" });
    assert.deepEqual(await fixture.store.inspect(fixture.plan), {
      diagnostic: "state document does not match its schema",
      status: "corrupt",
    });

    await writeCheckpoint(fixture.path, `{"padding":"${"x".repeat(65 * 1024)}"}`);
    assert.deepEqual(await fixture.store.inspect(fixture.plan), {
      diagnostic: "state file exceeds the 64 KiB limit",
      status: "corrupt",
    });
  } finally {
    await fixture.cleanup();
  }
});

test("startup fails closed for broad permissions and symbolic links", async () => {
  const fixture = await createStateFixture();
  try {
    await fixture.store.initialize(fixture.plan);
    await chmod(fixture.path, 0o640);
    assert.deepEqual(await fixture.store.inspect(fixture.plan), {
      mode: 0o640,
      status: "unsafe-permissions",
    });
    await assert.rejects(fixture.store.checkpointStep(fixture.plan, {
      attempt: 1,
      id: "first-step",
      index: 0,
      phase: "started",
    }), /Set the state file mode to 0600/u);

    await chmod(fixture.path, 0o600);
    const target = join(fixture.root, "target.json");
    await writeFile(target, await readFile(fixture.path));
    await rm(fixture.path);
    await symlink(target, fixture.path);
    const inspection = await fixture.store.inspect(fixture.plan);
    assert.deepEqual(inspection, {
      diagnostic: "state path is not a regular file",
      status: "corrupt",
    });
  } finally {
    await fixture.cleanup();
  }
});

test("filesystem permission errors fail closed without persisting raw error messages", async () => {
  const fixture = await createStateFixture();
  try {
    await fixture.store.initialize(fixture.plan);
    const fileSystem = new FaultInjectingStateFileSystem(event => {
      if (event.stage === "before-read") throw injectedFailure("EACCES");
    });
    const store = new RunnerStateStore({ fileSystem, path: fixture.path });

    await assert.rejects(store.inspect(fixture.plan), error => {
      assert.ok(error instanceof StateAccessError);
      assert.match(error.message, /EACCES/u);
      assert.doesNotMatch(error.message, /injected/u);
      return true;
    });
  } finally {
    await fixture.cleanup();
  }
});

test("startup removes only interrupted checkpoint temporary artifacts", async () => {
  const fixture = await createStateFixture();
  try {
    const directory = dirname(fixture.path);
    await mkdir(directory, { recursive: true });
    const interrupted = join(directory, `.${basename(fixture.path)}.123.interrupted.tmp`);
    const unrelated = join(directory, "unrelated.tmp");
    await writeFile(interrupted, "partial", { mode: 0o600 });
    await writeFile(unrelated, "keep", { mode: 0o600 });

    assert.deepEqual(await fixture.store.inspect(fixture.plan), { status: "absent" });
    await assert.rejects(readFile(interrupted), error => error.code === "ENOENT");
    assert.equal(await readFile(unrelated, "utf8"), "keep");
  } finally {
    await fixture.cleanup();
  }
});

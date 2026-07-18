import assert from "node:assert/strict";
import { dirname } from "node:path";
import test from "node:test";

import { RunnerStateStore, StateAccessError } from "@agent-boot/runner";

import {
  FaultInjectingStateFileSystem,
  checkpointTempNames,
  createStateFixture,
  injectedFailure,
  readCheckpoint,
} from "../test-support/runner-state-helpers.mjs";

const isTemporary = path => path.endsWith(".tmp");

test("writes sync the private temporary file before rename and sync the directory after", async () => {
  const fixture = await createStateFixture();
  try {
    const events = [];
    const fileSystem = new FaultInjectingStateFileSystem(event => events.push(event));
    const store = new RunnerStateStore({ clock: fixture.clock, fileSystem, path: fixture.path });
    await store.initialize(fixture.plan);

    const tempWrite = events.findIndex(event => event.stage === "after-write" && isTemporary(event.path));
    const tempSync = events.findIndex(event => event.stage === "after-sync" && isTemporary(event.path));
    const rename = events.findIndex(event => event.stage === "after-rename");
    const directorySync = events.findIndex(
      event => event.stage === "after-sync" && event.path === dirname(fixture.path),
    );
    assert.ok(tempWrite >= 0);
    assert.ok(tempWrite < tempSync);
    assert.ok(tempSync < rename);
    assert.ok(rename < directorySync);
    assert.equal(await checkpointTempNames(fixture.path).then(names => names.length), 0);
  } finally {
    await fixture.cleanup();
  }
});

for (const stage of ["before-write", "after-write", "before-sync", "before-rename"]) {
  test(`interruption at ${stage} leaves no partial state or temporary artifact`, async () => {
    const fixture = await createStateFixture();
    try {
      let failed = false;
      const fileSystem = new FaultInjectingStateFileSystem(event => {
        if (!failed && event.stage === stage && isTemporary(event.path)) {
          failed = true;
          throw injectedFailure();
        }
      });
      const store = new RunnerStateStore({ clock: fixture.clock, fileSystem, path: fixture.path });
      await assert.rejects(store.initialize(fixture.plan), StateAccessError);
      assert.deepEqual(await new RunnerStateStore({ path: fixture.path }).inspect(fixture.plan), {
        status: "absent",
      });
      assert.deepEqual(await checkpointTempNames(fixture.path), []);
    } finally {
      await fixture.cleanup();
    }
  });
}

test("a failed pre-rename update preserves the previous durable checkpoint", async () => {
  const fixture = await createStateFixture();
  try {
    const initial = await fixture.store.initialize(fixture.plan);
    let failed = false;
    const fileSystem = new FaultInjectingStateFileSystem(event => {
      if (!failed && event.stage === "after-write" && isTemporary(event.path)) {
        failed = true;
        throw injectedFailure();
      }
    });
    const store = new RunnerStateStore({ clock: fixture.clock, fileSystem, path: fixture.path });
    await assert.rejects(store.checkpointStep(fixture.plan, {
      attempt: 1,
      id: "first-step",
      index: 0,
      phase: "started",
    }), StateAccessError);

    assert.deepEqual(await readCheckpoint(fixture.path), initial);
    assert.deepEqual(await checkpointTempNames(fixture.path), []);
  } finally {
    await fixture.cleanup();
  }
});

test("an interruption after rename is recovered as the committed idempotent checkpoint", async () => {
  const fixture = await createStateFixture();
  try {
    let failed = false;
    const events = [];
    const fileSystem = new FaultInjectingStateFileSystem(event => {
      events.push(event);
      if (!failed && event.stage === "after-rename") {
        failed = true;
        throw injectedFailure();
      }
    });
    const store = new RunnerStateStore({ clock: fixture.clock, fileSystem, path: fixture.path });
    await assert.rejects(store.initialize(fixture.plan), StateAccessError);

    const renameIndex = events.findIndex(event => event.stage === "after-rename");
    const inspection = await store.inspect(fixture.plan);
    assert.equal(inspection.status, "valid");
    assert.equal(inspection.state.revision, 0);
    assert.ok(events.findIndex(
      (event, index) =>
        index > renameIndex &&
        event.stage === "after-sync" &&
        event.path === dirname(fixture.path),
    ) > renameIndex);
    assert.deepEqual(await store.initialize(fixture.plan), inspection.state);
    assert.deepEqual(await checkpointTempNames(fixture.path), []);
  } finally {
    await fixture.cleanup();
  }
});

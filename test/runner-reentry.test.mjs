import assert from "node:assert/strict";
import test from "node:test";

import { FakeCommandHost } from "@agent-boot/process";
import { identifyRunnerPlan } from "@agent-boot/runner";

import {
  automaticStep,
  createEngineFixture,
  environmentStep,
  successfulSpawn,
} from "../test-support/runner-engine-helpers.mjs";

const steps = [environmentStep(), automaticStep()];

const prepare = async (fixture, checkpoints, terminal = false) => {
  const identity = identifyRunnerPlan(
    { agentId: "test-agent", schemaVersion: 1 },
    fixture.serializedPlan,
  );
  await fixture.store.initialize(identity);
  for (const checkpoint of checkpoints) {
    await fixture.store.checkpointStep(identity, checkpoint);
  }
  if (terminal) await fixture.store.markSucceeded(identity);
};

const environmentCheckpoint = phase => ({
  attempt: 1,
  id: "set-agent-name",
  index: 0,
  phase,
});

const automaticCheckpoint = (phase, attempt = 1, index = 1) => ({
  attempt,
  id: "run-tool",
  index,
  phase,
});

const cases = [
  { checkpoints: [], expectedCalls: 1, name: "initialized" },
  {
    checkpoints: [environmentCheckpoint("started")],
    expectedCalls: 1,
    name: "environment started",
  },
  {
    checkpoints: [environmentCheckpoint("started"), environmentCheckpoint("succeeded")],
    expectedCalls: 1,
    name: "environment succeeded",
  },
  {
    checkpoints: [
      environmentCheckpoint("started"),
      environmentCheckpoint("succeeded"),
      automaticCheckpoint("started"),
    ],
    expectedCalls: 1,
    name: "automatic started",
  },
  {
    checkpoints: [
      environmentCheckpoint("started"),
      environmentCheckpoint("succeeded"),
      automaticCheckpoint("started"),
      automaticCheckpoint("failed"),
    ],
    expectedCalls: 1,
    name: "automatic attempt failed",
  },
  {
    checkpoints: [
      environmentCheckpoint("started"),
      environmentCheckpoint("succeeded"),
      automaticCheckpoint("started"),
      automaticCheckpoint("succeeded"),
    ],
    expectedCalls: 0,
    name: "automatic succeeded",
  },
  {
    checkpoints: [
      environmentCheckpoint("started"),
      environmentCheckpoint("succeeded"),
      automaticCheckpoint("started"),
      automaticCheckpoint("succeeded"),
    ],
    expectedCalls: 0,
    name: "terminal success",
    terminal: true,
  },
];

for (const scenario of cases) {
  test(`re-entry from ${scenario.name} advances without repeating completed work`, async () => {
    const host = new FakeCommandHost();
    if (scenario.expectedCalls === 1) host.scriptSpawnResult(successfulSpawn);
    const fixture = await createEngineFixture(steps, { host });
    try {
      await prepare(fixture, scenario.checkpoints, scenario.terminal);

      const result = await fixture.engine.run();

      assert.equal(result.status, "succeeded");
      assert.equal(host.spawnCalls.length, scenario.expectedCalls);
      if (host.spawnCalls.length === 1) {
        assert.equal(host.spawnCalls[0].environment.AGENT_NAME, "My Agent");
      }
    } finally {
      await fixture.cleanup();
    }
  });
}

test("a persisted success is not repeated when interruption occurs after the checkpoint", async () => {
  const host = new FakeCommandHost().scriptSpawnResult(successfulSpawn);
  const fixture = await createEngineFixture([automaticStep()], { host });
  try {
    const interruptingStore = {
      checkpointStep: async (plan, checkpoint) => {
        const state = await fixture.store.checkpointStep(plan, checkpoint);
        if (checkpoint.phase === "succeeded") throw new Error("simulated reboot");
        return state;
      },
      initialize: plan => fixture.store.initialize(plan),
      markFailed: (plan, diagnostic) => fixture.store.markFailed(plan, diagnostic),
      markSucceeded: plan => fixture.store.markSucceeded(plan),
    };
    await assert.rejects(
      fixture.createEngine({ stateStore: interruptingStore }).run(),
      /simulated reboot/u,
    );
    assert.equal(host.spawnCalls.length, 1);

    const resumedHost = new FakeCommandHost();
    const result = await fixture.createEngine({ commandHost: resumedHost }).run();
    assert.equal(result.status, "succeeded");
    assert.equal(resumedHost.spawnCalls.length, 0);
  } finally {
    await fixture.cleanup();
  }
});

test("re-entry after the final allowed failure terminates without another command", async () => {
  const host = new FakeCommandHost();
  const fixture = await createEngineFixture([automaticStep()], {
    engineOptions: { automaticPolicy: { maxAttempts: 2, timeoutMs: 1_000 } },
    host,
  });
  try {
    const identity = identifyRunnerPlan(
      { agentId: "test-agent", schemaVersion: 1 },
      fixture.serializedPlan,
    );
    await fixture.store.initialize(identity);
    await fixture.store.checkpointStep(identity, automaticCheckpoint("started", 1, 0));
    await fixture.store.checkpointStep(identity, automaticCheckpoint("failed", 1, 0));
    await fixture.store.checkpointStep(identity, automaticCheckpoint("started", 2, 0));
    await fixture.store.checkpointStep(identity, automaticCheckpoint("failed", 2, 0));

    const result = await fixture.engine.run();

    assert.equal(result.status, "failed");
    assert.equal(host.spawnCalls.length, 0);
    assert.equal(result.state.terminal.diagnostic.attempt, 2);
  } finally {
    await fixture.cleanup();
  }
});

test("re-entry rejects a checkpoint that does not match the immutable plan", async () => {
  const host = new FakeCommandHost();
  const fixture = await createEngineFixture([automaticStep()], { host });
  try {
    const identity = identifyRunnerPlan(
      { agentId: "test-agent", schemaVersion: 1 },
      fixture.serializedPlan,
    );
    await fixture.store.initialize(identity);
    await fixture.store.checkpointStep(identity, {
      attempt: 1,
      id: "different-step",
      index: 0,
      phase: "started",
    });

    const result = await fixture.engine.run();

    assert.equal(result.status, "failed");
    assert.equal(host.spawnCalls.length, 0);
    assert.deepEqual(result.state.terminal.diagnostic, {
      code: "manual-intervention-required",
      recovery: "manual-intervention",
      stepId: "different-step",
    });
  } finally {
    await fixture.cleanup();
  }
});

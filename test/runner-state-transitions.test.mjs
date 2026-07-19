import assert from "node:assert/strict";
import test from "node:test";
import { TextEncoder } from "node:util";

import {
  CheckpointValidationError,
  RUNNER_CHECKPOINT_SCHEMA_VERSION,
  StateTransitionError,
  identifyRunnerPlan,
  parseRunnerCheckpoint,
} from "@agent-boot/runner";

import { createStateFixture, readCheckpoint } from "../test-support/runner-state-helpers.mjs";

const step = (phase, attempt = 1, overrides = {}) => ({
  attempt,
  id: "install-secret",
  index: 0,
  phase,
  ...overrides,
});

const transaction = phase => ({
  destination: ".config/service/credential",
  phase,
  secretId: "service-credential",
  stepId: "install-secret",
});

test("step attempts are monotonic, retryable, and idempotent", async () => {
  const fixture = await createStateFixture();
  try {
    await fixture.store.initialize(fixture.plan);
    fixture.clock.advance(1_000);
    const started = await fixture.store.checkpointStep(fixture.plan, step("started"));
    const duplicate = await fixture.store.checkpointStep(fixture.plan, step("started"));
    assert.deepEqual(duplicate, started);
    assert.equal(duplicate.revision, 1);
    assert.equal(duplicate.updatedAt, "2026-07-19T00:00:01.000Z");

    const failed = await fixture.store.checkpointStep(fixture.plan, step("failed"));
    const retry = await fixture.store.checkpointStep(fixture.plan, step("started", 2));
    assert.equal(failed.currentStep.attempt, 1);
    assert.equal(retry.currentStep.attempt, 2);
    assert.equal(retry.revision, 3);

    await assert.rejects(
      fixture.store.checkpointStep(fixture.plan, step("started", 4)),
      StateTransitionError,
    );
    assert.deepEqual(await readCheckpoint(fixture.path), retry);
  } finally {
    await fixture.cleanup();
  }
});

test("concurrent duplicate checkpoints serialize to one durable revision", async () => {
  const fixture = await createStateFixture();
  try {
    await fixture.store.initialize(fixture.plan);
    const results = await Promise.all([
      fixture.store.checkpointStep(fixture.plan, step("started")),
      fixture.store.checkpointStep(fixture.plan, step("started")),
    ]);
    assert.equal(results[0].revision, 1);
    assert.deepEqual(results[1], results[0]);
    assert.equal((await readCheckpoint(fixture.path)).revision, 1);
  } finally {
    await fixture.cleanup();
  }
});

test("secret transactions resume one idempotent phase at a time", async () => {
  const fixture = await createStateFixture();
  try {
    await fixture.store.initialize(fixture.plan);
    await fixture.store.checkpointStep(fixture.plan, step("started"));
    const prepared = await fixture.store.checkpointSecretTransaction(
      fixture.plan,
      transaction("prepared"),
    );
    assert.deepEqual(
      await fixture.store.checkpointSecretTransaction(fixture.plan, transaction("prepared")),
      prepared,
    );
    await assert.rejects(
      fixture.store.checkpointSecretTransaction(fixture.plan, transaction("source-removed")),
      StateTransitionError,
    );
    await assert.rejects(
      fixture.store.checkpointStep(fixture.plan, step("succeeded")),
      /must be committed/u,
    );
    const failed = await fixture.store.checkpointStep(fixture.plan, step("failed"));
    assert.equal(failed.secretTransaction.phase, "prepared");
    await fixture.store.checkpointStep(fixture.plan, step("started", 2));

    for (const phase of ["installed", "source-removed", "committed"]) {
      await fixture.store.checkpointSecretTransaction(fixture.plan, transaction(phase));
    }
    const succeeded = await fixture.store.checkpointStep(fixture.plan, step("succeeded", 2));
    assert.equal(succeeded.secretTransaction.phase, "committed");

    const next = await fixture.store.checkpointStep(fixture.plan, {
      attempt: 1,
      id: "next-step",
      index: 1,
      phase: "started",
    });
    assert.equal(next.secretTransaction, null);
  } finally {
    await fixture.cleanup();
  }
});

test("fire-and-forget process identities advance through bounded generations", async () => {
  const fixture = await createStateFixture();
  const identity = {
    bootId: "11111111-1111-4111-8111-111111111111",
    pid: 1234,
    processGroupId: 1234,
    startTimeTicks: "987654",
  };
  try {
    await fixture.store.initialize(fixture.plan);
    await fixture.store.checkpointStep(fixture.plan, {
      attempt: 1,
      id: "support-service",
      index: 0,
      phase: "started",
    });
    const registered = await fixture.store.checkpointFireAndForgetProcess(fixture.plan, {
      generation: 1,
      identity,
      kind: "register",
      stepId: "support-service",
      stepIndex: 0,
    });
    assert.equal(registered.fireAndForgetProcesses[0].phase, "registered");

    const accepted = await fixture.store.checkpointFireAndForgetProcess(fixture.plan, {
      generation: 1,
      identity,
      kind: "accept",
      stepId: "support-service",
      stepIndex: 0,
    });
    assert.equal(accepted.fireAndForgetProcesses[0].phase, "accepted");
    await assert.rejects(
      fixture.store.checkpointFireAndForgetProcess(fixture.plan, {
        generation: 1,
        identity: { ...identity, startTimeTicks: "987655" },
        kind: "finish",
        outcome: "runner-shutdown",
        exitCode: null,
        signal: "SIGTERM",
        stepId: "support-service",
        stepIndex: 0,
      }),
      StateTransitionError,
    );

    const finished = await fixture.store.checkpointFireAndForgetProcess(fixture.plan, {
      generation: 1,
      identity,
      kind: "finish",
      outcome: "runner-shutdown",
      exitCode: null,
      signal: "SIGTERM",
      stepId: "support-service",
      stepIndex: 0,
    });
    assert.equal(finished.fireAndForgetProcesses[0].phase, "finished");
    assert.doesNotMatch(JSON.stringify(finished), /arguments|environment|stdout|stderr/u);

    const replacement = await fixture.store.checkpointFireAndForgetProcess(fixture.plan, {
      generation: 2,
      identity: { ...identity, pid: 1235, processGroupId: 1235 },
      kind: "register",
      stepId: "support-service",
      stepIndex: 0,
    });
    assert.equal(replacement.fireAndForgetProcesses[0].generation, 2);
  } finally {
    await fixture.cleanup();
  }
});

test("terminal success and failure checkpoints are immutable and idempotent", async () => {
  const successFixture = await createStateFixture();
  try {
    await successFixture.store.initialize(successFixture.plan);
    const success = await successFixture.store.markSucceeded(successFixture.plan);
    assert.deepEqual(await successFixture.store.markSucceeded(successFixture.plan), success);
    await assert.rejects(
      successFixture.store.checkpointStep(successFixture.plan, step("started")),
      StateTransitionError,
    );
  } finally {
    await successFixture.cleanup();
  }

  const failureFixture = await createStateFixture();
  try {
    await failureFixture.store.initialize(failureFixture.plan);
    await failureFixture.store.checkpointStep(failureFixture.plan, step("started"));
    const diagnostic = {
      attempt: 1,
      code: "step-attempt-failed",
      exitCode: 7,
      recovery: "retry-step",
      signal: null,
      stepId: "install-secret",
    };
    const failure = await failureFixture.store.markFailed(failureFixture.plan, diagnostic);
    assert.deepEqual(await failureFixture.store.markFailed(failureFixture.plan, diagnostic), failure);
    assert.deepEqual(failure.terminal.diagnostic, diagnostic);
    assert.doesNotMatch(JSON.stringify(failure), /stdout|stderr|message|secretValue/u);
    await assert.rejects(failureFixture.store.markSucceeded(failureFixture.plan), StateTransitionError);
  } finally {
    await failureFixture.cleanup();
  }
});

test("checkpoint schema excludes free-form diagnostics and secret contents", () => {
  const document = {
    currentStep: null,
    fireAndForgetProcesses: [],
    plan: { agentId: "test-agent", planSha256: "a".repeat(64), schemaVersion: 1 },
    revision: 1,
    schemaVersion: RUNNER_CHECKPOINT_SCHEMA_VERSION,
    secretTransaction: null,
    terminal: {
      at: "2026-07-19T00:00:00.000Z",
      diagnostic: {
        code: "step-attempt-failed",
        message: "credential contents",
        recovery: "retry-step",
      },
      status: "failed",
    },
    updatedAt: "2026-07-19T00:00:00.000Z",
  };
  assert.throws(() => parseRunnerCheckpoint(document), CheckpointValidationError);
});

test("plan identity hashes exact serialized bytes", () => {
  const plan = { agentId: "test-agent", schemaVersion: 1 };
  const first = identifyRunnerPlan(plan, '{"agentId":"test-agent"}');
  const same = identifyRunnerPlan(plan, new TextEncoder().encode('{"agentId":"test-agent"}'));
  const changed = identifyRunnerPlan(plan, '{ "agentId": "test-agent" }');

  assert.deepEqual(first, same);
  assert.notEqual(first.planSha256, changed.planSha256);
});

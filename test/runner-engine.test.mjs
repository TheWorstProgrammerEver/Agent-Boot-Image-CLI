import assert from "node:assert/strict";
import { execPath } from "node:process";
import test from "node:test";

import { FakeCommandHost, NodeSpawnAdapter } from "@agent-boot/process";
import {
  RunnerConfigurationError,
  RunnerEngine,
  RunnerEnvironment,
  RunnerPlanError,
} from "@agent-boot/runner";

import {
  automaticStep,
  createEngineFixture,
  environmentStep,
  serializePlan,
  successfulSpawn,
} from "../test-support/runner-engine-helpers.mjs";

test("environment changes persist across children and resume from immutable plan state", async () => {
  const marker = "public-value-that-must-not-be-recorded";
  const steps = [
    { ...environmentStep(), value: marker },
    automaticStep("first-command"),
    {
      id: "unset-agent-name",
      key: "AGENT_NAME",
      kind: "environment",
      operation: "unset",
    },
    automaticStep("second-command"),
  ];
  const progress = [];
  const host = new FakeCommandHost()
    .scriptSpawnResult(successfulSpawn)
    .scriptSpawnResult(successfulSpawn);
  const fixture = await createEngineFixture(steps, {
    engineOptions: { onProgress: event => progress.push(event) },
    host,
  });
  try {
    const result = await fixture.engine.run();

    assert.equal(result.status, "succeeded");
    assert.equal(host.spawnCalls.length, 2);
    for (const call of host.spawnCalls) {
      assert.equal(call.cwd, "/home/my-user/workspace");
      assert.equal(call.environment.HOME, "/home/my-user");
      assert.equal(call.environment.PATH, "/opt/agent/bin:/usr/bin");
      assert.deepEqual(call.lifetime, { policy: "managed" });
      assert.equal(call.stdio, "inherit");
      assert.equal(call.timeoutMs, 60_000);
    }
    assert.equal(host.spawnCalls[0].environment.AGENT_NAME, marker);
    assert.equal(host.spawnCalls[1].environment.AGENT_NAME, undefined);
    assert.doesNotMatch(JSON.stringify(result.state), new RegExp(marker, "u"));
    assert.doesNotMatch(JSON.stringify(progress), new RegExp(marker, "u"));

    const resumedHost = new FakeCommandHost();
    const resumed = fixture.createEngine({ commandHost: resumedHost });
    assert.equal((await resumed.run()).status, "succeeded");
    assert.equal(resumedHost.spawnCalls.length, 0);
  } finally {
    await fixture.cleanup();
  }
});

test("runner context is snapshotted and resolves scoped working directories", () => {
  const options = {
    basePath: "/base/bin",
    homeDirectory: "/home/my-user",
    workingDirectory: "/srv/agent-work",
  };
  const environment = new RunnerEnvironment(options);
  options.basePath = "/mutated";
  options.homeDirectory = "/mutated";
  options.workingDirectory = "/mutated";

  assert.deepEqual(environment.forStep([], 0), {
    HOME: "/home/my-user",
    PATH: "/base/bin",
  });
  assert.equal(
    environment.workingDirectoryFor({ arguments: [], executable: "tool" }),
    "/srv/agent-work",
  );
  assert.equal(
    environment.workingDirectoryFor({
      arguments: [],
      executable: "tool",
      workingDirectory: { path: "workspace/project", scope: "user-home" },
    }),
    "/home/my-user/workspace/project",
  );
  assert.equal(
    environment.workingDirectoryFor({
      arguments: [],
      executable: "tool",
      workingDirectory: { path: "var/lib/project", scope: "system" },
    }),
    "/var/lib/project",
  );
  assert.throws(
    () => new RunnerEnvironment({ ...options, homeDirectory: "relative" }),
    RunnerConfigurationError,
  );
});

test("a harmless child process receives the configured runner environment", async () => {
  const assertion = [
    'process.env.HOME === "/tmp/agent-home"',
    'process.env.PATH === "/agent/bin:/usr/bin"',
    'process.env.AGENT_NAME === "My Agent"',
    'process.cwd() === "/tmp"',
  ].join(" && ");
  const fixture = await createEngineFixture([
    environmentStep(),
    automaticStep("inspect-environment", {
      arguments: ["--eval", `process.exit(${assertion} ? 0 : 23)`],
      executable: execPath,
    }),
  ], {
    engineOptions: {
      environment: {
        basePath: "/agent/bin:/usr/bin",
        homeDirectory: "/tmp/agent-home",
        workingDirectory: "/tmp",
      },
    },
    host: new NodeSpawnAdapter(),
  });
  try {
    assert.equal((await fixture.engine.run()).status, "succeeded");
  } finally {
    await fixture.cleanup();
  }
});

test("automatic commands retry only after checkpointed failure and stop at the bound", async () => {
  const host = new FakeCommandHost()
    .scriptSpawnResult({ result: { exitCode: 7, reason: "exit", signal: null } })
    .scriptSpawnResult({ result: { exitCode: null, reason: "signal", signal: "SIGTERM" } })
    .scriptSpawnResult({ result: { exitCode: 9, reason: "exit", signal: null } });
  const fixture = await createEngineFixture([automaticStep()], {
    engineOptions: { automaticPolicy: { maxAttempts: 3, timeoutMs: 10_000 } },
    host,
  });
  try {
    const result = await fixture.engine.run();

    assert.equal(result.status, "failed");
    assert.equal(host.spawnCalls.length, 3);
    assert.equal(result.state.currentStep.attempt, 3);
    assert.equal(result.state.currentStep.phase, "failed");
    assert.deepEqual(result.state.terminal.diagnostic, {
      attempt: 3,
      code: "step-attempt-failed",
      exitCode: 9,
      recovery: "manual-intervention",
      signal: null,
      stepId: "run-tool",
    });
  } finally {
    await fixture.cleanup();
  }
});

test("command exceptions are reduced to redacted structured diagnostics", async () => {
  const marker = "not-for-progress-or-state";
  const progress = [];
  const host = new FakeCommandHost().scriptSpawnError(new Error(marker));
  const fixture = await createEngineFixture([automaticStep()], {
    engineOptions: {
      automaticPolicy: { maxAttempts: 1, timeoutMs: 10_000 },
      onProgress: event => progress.push(event),
    },
    host,
  });
  try {
    const result = await fixture.engine.run();
    const observable = JSON.stringify({ progress, state: result.state });

    assert.equal(result.status, "failed");
    assert.doesNotMatch(observable, new RegExp(marker, "u"));
    assert.doesNotMatch(observable, /stdout|stderr|message|arguments|environment/u);
  } finally {
    await fixture.cleanup();
  }
});

test("known unsupported and unknown steps fail before command execution", async () => {
  const unsupported = {
    id: "render-prompt",
    kind: "prompt",
    renderedPromptId: "rendered-prompt",
    retention: "ephemeral",
    templateId: "prompt-template",
    variables: [],
  };
  const fixture = await createEngineFixture([automaticStep("would-run"), unsupported]);
  try {
    const result = await fixture.engine.run();

    assert.equal(result.status, "failed");
    assert.equal(fixture.host.spawnCalls.length, 0);
    assert.equal(result.state.currentStep, null);
    assert.deepEqual(result.state.terminal.diagnostic, {
      code: "manual-intervention-required",
      recovery: "manual-intervention",
      stepId: "render-prompt",
    });
  } finally {
    await fixture.cleanup();
  }

  const invalidHost = new FakeCommandHost();
  const invalidStore = {
    checkpointStep: () => assert.fail("must not checkpoint"),
    initialize: () => assert.fail("must not initialize"),
    markFailed: () => assert.fail("must not fail state"),
    markSucceeded: () => assert.fail("must not succeed state"),
  };
  const invalid = JSON.parse(serializePlan([]));
  invalid.steps = [{ id: "unknown", kind: "future-kind", value: "private-marker" }];
  assert.throws(
    () =>
      new RunnerEngine({
        automaticPolicy: { maxAttempts: 1, timeoutMs: 1_000 },
        commandHost: invalidHost,
        environment: {
          basePath: "/usr/bin",
          homeDirectory: "/home/my-user",
          workingDirectory: "/home/my-user",
        },
        fireAndForgetPolicy: {
          acceptanceWindowMs: 10,
          maxLaunchAttempts: 1,
          terminationGraceMs: 100,
        },
        manualPolicy: {
          completionCheckTimeoutMs: 1_000,
          maximumPollIntervalMs: 1_000,
        },
        serializedPlan: JSON.stringify(invalid),
        stateStore: invalidStore,
      }),
    error => {
      assert.ok(error instanceof RunnerPlanError);
      assert.doesNotMatch(error.message, /private-marker/u);
      return true;
    },
  );
  assert.equal(invalidHost.spawnCalls.length, 0);
});

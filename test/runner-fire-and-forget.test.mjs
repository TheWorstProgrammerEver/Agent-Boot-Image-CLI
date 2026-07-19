import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { execPath } from "node:process";
import test from "node:test";

import { NodeSpawnAdapter } from "@agent-boot/process";
import {
  RunnerInterruptedError,
  LinuxProcessIdentityHost,
  RunnerPlanError,
  identifyRunnerPlan,
} from "@agent-boot/runner";

import {
  CURRENT_BOOT_ID,
  PRIOR_BOOT_ID,
  ScriptedSpawnHost,
  createIdentityHost,
  fireAndForgetStep,
} from "../test-support/fire-and-forget-helpers.mjs";
import {
  automaticStep,
  createEngineFixture,
  successfulSpawn,
} from "../test-support/runner-engine-helpers.mjs";
import {
  processIsRunning,
  waitFor,
} from "../test-support/process-test-helpers.mjs";

const policy = {
  acceptanceWindowMs: 10,
  maxLaunchAttempts: 1,
  terminationGraceMs: 100,
};

const seedPriorBootLaunch = async (fixture, identityHost, phase) => {
  const identity = identifyRunnerPlan(
    { agentId: "test-agent", schemaVersion: 1 },
    fixture.serializedPlan,
  );
  const processIdentity = identityHost.add(801, PRIOR_BOOT_ID);
  await fixture.store.initialize(identity);
  await fixture.store.checkpointStep(identity, {
    attempt: 1,
    id: "start-support",
    index: 0,
    phase: "started",
  });
  await fixture.store.checkpointFireAndForgetProcess(identity, {
    generation: 1,
    identity: processIdentity,
    kind: "register",
    stepId: "start-support",
    stepIndex: 0,
  });
  if (phase === "failed") {
    await fixture.store.checkpointFireAndForgetProcess(identity, {
      exitCode: 17,
      generation: 1,
      identity: processIdentity,
      kind: "finish",
      outcome: "exited-before-acceptance",
      signal: null,
      stepId: "start-support",
      stepIndex: 0,
    });
  }
  identityHost.remove(801);
};

test("launch errors and pre-acceptance exits have distinct redacted failures", async () => {
  const marker = "argument-that-must-not-be-persisted";
  const launchIdentityHost = createIdentityHost();
  const launchHost = new ScriptedSpawnHost(launchIdentityHost)
    .scriptError(new Error(`spawn failed: ${marker}`));
  const launchFixture = await createEngineFixture([
    fireAndForgetStep("launch-error", { arguments: [marker] }),
  ], {
    engineOptions: {
      fireAndForgetPolicy: policy,
      lifecycleWait: async () => undefined,
      processIdentityHost: launchIdentityHost,
    },
    host: launchHost,
  });
  try {
    const result = await launchFixture.engine.run();
    assert.equal(result.status, "failed");
    assert.equal(result.state.terminal.diagnostic.code, "fire-and-forget-launch-failed");
    assert.doesNotMatch(JSON.stringify(result.state), new RegExp(marker, "u"));
  } finally {
    await launchFixture.cleanup();
  }

  const exitIdentityHost = createIdentityHost();
  const exitHost = new ScriptedSpawnHost(exitIdentityHost).scriptImmediate(
    { exitCode: 23, reason: "exit", signal: null },
    { pid: 201 },
  );
  const exitFixture = await createEngineFixture([fireAndForgetStep("early-exit")], {
    engineOptions: {
      fireAndForgetPolicy: policy,
      lifecycleWait: async () => undefined,
      processIdentityHost: exitIdentityHost,
    },
    host: exitHost,
  });
  try {
    const result = await exitFixture.engine.run();
    assert.equal(result.status, "failed");
    assert.equal(result.state.terminal.diagnostic.code, "fire-and-forget-early-exit");
    assert.equal(result.state.terminal.diagnostic.exitCode, 23);
    assert.equal(result.state.fireAndForgetProcesses[0].outcome, "exited-before-acceptance");
  } finally {
    await exitFixture.cleanup();
  }
});

test("accepted processes record stable metadata and stop at runner completion", async () => {
  const identityHost = createIdentityHost();
  const host = new ScriptedSpawnHost(identityHost).scriptRunning(301);
  const fixture = await createEngineFixture([fireAndForgetStep()], {
    engineOptions: {
      fireAndForgetPolicy: policy,
      lifecycleWait: async () => undefined,
      processIdentityHost: identityHost,
    },
    host,
  });
  try {
    const result = await fixture.engine.run();
    const process = result.state.fireAndForgetProcesses[0];

    assert.equal(result.status, "succeeded");
    assert.deepEqual(host.spawnCalls[0].lifetime, { policy: "managed" });
    assert.equal(host.spawnCalls[0].forwardSignals, undefined);
    assert.deepEqual(host.spawnCalls[0].control.cancelSignals, ["SIGTERM"]);
    assert.deepEqual(process.identity, {
      bootId: CURRENT_BOOT_ID,
      pid: 301,
      processGroupId: 301,
      startTimeTicks: "30100",
    });
    assert.equal(process.outcome, "runner-shutdown");
    assert.equal(process.phase, "finished");
    assert.doesNotMatch(JSON.stringify(result.state), /private-marker|arguments|environment/u);
  } finally {
    await fixture.cleanup();
  }
});

test("a process exit after acceptance fails the active runner without relabeling launch", async () => {
  const identityHost = createIdentityHost();
  const host = new ScriptedSpawnHost(identityHost)
    .scriptRunning(401)
    .scriptImmediate(successfulSpawn.result, {
      beforeSpawn: scripted => scripted.complete(0),
    });
  const fixture = await createEngineFixture([
    fireAndForgetStep(),
    automaticStep("dependent-command"),
  ], {
    engineOptions: {
      fireAndForgetPolicy: policy,
      lifecycleWait: async () => undefined,
      processIdentityHost: identityHost,
    },
    host,
  });
  try {
    const result = await fixture.engine.run();
    assert.equal(result.status, "failed");
    assert.equal(result.state.terminal.diagnostic.code, "fire-and-forget-process-exited");
    assert.equal(result.state.fireAndForgetProcesses[0].outcome, "exited-after-acceptance");
  } finally {
    await fixture.cleanup();
  }
});

test("runner cancellation forwards an allowed signal and leaves resumable state", async () => {
  const controller = new globalThis.AbortController();
  const identityHost = createIdentityHost();
  const host = new ScriptedSpawnHost(identityHost).scriptRunning(501);
  const fixture = await createEngineFixture([fireAndForgetStep()], {
    engineOptions: {
      cancellation: controller.signal,
      fireAndForgetPolicy: policy,
      lifecycleWait: async () => {
        controller.abort("SIGINT");
      },
      processIdentityHost: identityHost,
    },
    host,
  });
  try {
    await assert.rejects(fixture.engine.run(), RunnerInterruptedError);
    const identity = identifyRunnerPlan(
      { agentId: "test-agent", schemaVersion: 1 },
      fixture.serializedPlan,
    );
    const inspection = await fixture.store.inspect(identity);
    assert.equal(inspection.status, "valid");
    assert.equal(inspection.state.terminal, null);
    assert.equal(inspection.state.fireAndForgetProcesses[0].outcome, "runner-shutdown");
    assert.deepEqual(host.spawnCalls[0].control.cancelSignals, ["SIGINT"]);

    host.scriptRunning(502);
    const resumed = await fixture.createEngine({ cancellation: undefined }).run();
    assert.equal(resumed.status, "succeeded");
    assert.equal(resumed.state.fireAndForgetProcesses[0].generation, 2);
  } finally {
    await fixture.cleanup();
  }
});

test("unsupported durable lifetime combinations fail before spawning", async () => {
  const fixture = await createEngineFixture([]);
  try {
    const plan = JSON.parse(fixture.serializedPlan);
    plan.steps = [{ ...fireAndForgetStep(), lifetime: "reboot" }];
    assert.throws(
      () => fixture.createEngine({ serializedPlan: JSON.stringify(plan) }),
      RunnerPlanError,
    );
    assert.equal(fixture.host.spawnCalls.length, 0);
  } finally {
    await fixture.cleanup();
  }
});

test("an ambiguous started launch consumes its attempt without spawning a duplicate", async () => {
  const identityHost = createIdentityHost();
  const host = new ScriptedSpawnHost(identityHost);
  const fixture = await createEngineFixture([fireAndForgetStep()], {
    engineOptions: {
      fireAndForgetPolicy: policy,
      lifecycleWait: async () => undefined,
      processIdentityHost: identityHost,
    },
    host,
  });
  try {
    const identity = identifyRunnerPlan(
      { agentId: "test-agent", schemaVersion: 1 },
      fixture.serializedPlan,
    );
    await fixture.store.initialize(identity);
    await fixture.store.checkpointStep(identity, {
      attempt: 1,
      id: "start-support",
      index: 0,
      phase: "started",
    });

    const result = await fixture.engine.run();
    assert.equal(result.status, "failed");
    assert.equal(result.state.terminal.diagnostic.code, "fire-and-forget-launch-failed");
    assert.equal(host.spawnCalls.length, 0);
  } finally {
    await fixture.cleanup();
  }
});

test("a harmless real child is accepted and fully cleaned up", async () => {
  const fixture = await createEngineFixture([
    fireAndForgetStep("real-child", {
      arguments: ["--eval", "setInterval(() => undefined, 1000)"],
      executable: execPath,
    }),
  ], {
    engineOptions: {
      environment: {
        basePath: "/usr/bin",
        homeDirectory: "/tmp",
        workingDirectory: "/tmp",
      },
      fireAndForgetPolicy: {
        acceptanceWindowMs: 25,
        maxLaunchAttempts: 1,
        terminationGraceMs: 200,
      },
    },
    host: new NodeSpawnAdapter({ terminationGraceMs: 100 }),
  });
  try {
    const result = await fixture.engine.run();
    const pid = result.state.fireAndForgetProcesses[0].identity.pid;
    assert.equal(result.status, "succeeded");
    assert.throws(() => globalThis.process.kill(pid, 0), { code: "ESRCH" });
  } finally {
    await fixture.cleanup();
  }
});

test("adopted cleanup escalates when a resistant descendant outlives its leader", async () => {
  const descendant = [
    "process.on('SIGTERM', () => {});",
    "process.stdout.write('ready:' + String(process.pid) + '\\n');",
    "setInterval(() => {}, 1000);",
  ].join("");
  const leader = [
    "const { spawn } = require('node:child_process');",
    `spawn(process.execPath, ['--eval', ${JSON.stringify(descendant)}], { stdio: ['ignore', 1, 2] });`,
    "setInterval(() => {}, 1000);",
  ].join("");
  const running = spawn(execPath, ["--eval", leader], {
    detached: true,
    stdio: ["ignore", "pipe", "inherit"],
  });
  const closed = new Promise(resolve => running.once("close", resolve));
  let output = "";
  running.stdout.setEncoding("utf8");
  running.stdout.on("data", chunk => { output += chunk; });

  try {
    await waitFor(() => /^ready:\d+\n$/u.test(output));
    const descendantPid = Number.parseInt(output.slice("ready:".length), 10);
    const identityHost = new LinuxProcessIdentityHost();
    const identity = await identityHost.capture(running.pid);
    assert.notEqual(identity, undefined);

    const stopped = await identityHost.terminate(identity, "SIGTERM", 50);

    assert.equal(stopped, true);
    await waitFor(() => !processIsRunning(descendantPid));
    assert.equal(processIsRunning(descendantPid), false);
  } finally {
    try {
      globalThis.process.kill(-running.pid, "SIGKILL");
    } catch (error) {
      assert.equal(error.code, "ESRCH");
    }
    await closed;
  }
});

test("same-boot recovery suppresses duplicates while reboot recovery relaunches", async () => {
  for (const scenario of [
    { bootId: CURRENT_BOOT_ID, expectedFireLaunches: 0, name: "same boot" },
    { bootId: PRIOR_BOOT_ID, expectedFireLaunches: 1, name: "new boot" },
  ]) {
    const identityHost = createIdentityHost();
    const host = new ScriptedSpawnHost(identityHost);
    if (scenario.expectedFireLaunches === 1) host.scriptRunning(702);
    host.scriptImmediate(successfulSpawn.result);
    const steps = [fireAndForgetStep(), automaticStep("after-support")];
    const fixture = await createEngineFixture(steps, {
      engineOptions: {
        fireAndForgetPolicy: policy,
        lifecycleWait: async () => undefined,
        processIdentityHost: identityHost,
      },
      host,
    });
    try {
      const identity = identifyRunnerPlan(
        { agentId: "test-agent", schemaVersion: 1 },
        fixture.serializedPlan,
      );
      const processIdentity = identityHost.add(701, scenario.bootId);
      await fixture.store.initialize(identity);
      await fixture.store.checkpointStep(identity, {
        attempt: 1,
        id: "start-support",
        index: 0,
        phase: "started",
      });
      await fixture.store.checkpointFireAndForgetProcess(identity, {
        generation: 1,
        identity: processIdentity,
        kind: "register",
        stepId: "start-support",
        stepIndex: 0,
      });
      await fixture.store.checkpointFireAndForgetProcess(identity, {
        generation: 1,
        identity: processIdentity,
        kind: "accept",
        stepId: "start-support",
        stepIndex: 0,
      });
      await fixture.store.checkpointStep(identity, {
        attempt: 1,
        id: "start-support",
        index: 0,
        phase: "succeeded",
      });
      if (scenario.bootId === PRIOR_BOOT_ID) identityHost.remove(701);

      const result = await fixture.engine.run();
      assert.equal(result.status, "succeeded", scenario.name);
      const fireCalls = host.spawnCalls.filter(call => call.executable === "support-service");
      assert.equal(fireCalls.length, scenario.expectedFireLaunches, scenario.name);
      assert.equal(
        result.state.fireAndForgetProcesses[0].generation,
        scenario.expectedFireLaunches + 1,
        scenario.name,
      );
    } finally {
      await fixture.cleanup();
    }
  }
});

test("prior-boot launch checkpoints consume their attempt before a safe relaunch", async () => {
  for (const scenario of ["registered", "failed"]) {
    const identityHost = createIdentityHost();
    const host = new ScriptedSpawnHost(identityHost).scriptRunning(802);
    const fixture = await createEngineFixture([fireAndForgetStep()], {
      engineOptions: {
        fireAndForgetPolicy: { ...policy, maxLaunchAttempts: 2 },
        lifecycleWait: async () => undefined,
        processIdentityHost: identityHost,
      },
      host,
    });
    try {
      await seedPriorBootLaunch(fixture, identityHost, scenario);

      const result = await fixture.engine.run();

      assert.equal(result.status, "succeeded", scenario);
      assert.equal(result.state.currentStep.attempt, 2, scenario);
      assert.equal(result.state.fireAndForgetProcesses[0].generation, 2, scenario);
      assert.equal(host.spawnCalls.length, 1, scenario);
    } finally {
      await fixture.cleanup();
    }
  }
});

test("reboot recovery cannot replay an exhausted failed launch", async () => {
  const identityHost = createIdentityHost();
  const host = new ScriptedSpawnHost(identityHost);
  const fixture = await createEngineFixture([fireAndForgetStep()], {
    engineOptions: {
      fireAndForgetPolicy: policy,
      lifecycleWait: async () => undefined,
      processIdentityHost: identityHost,
    },
    host,
  });
  try {
    await seedPriorBootLaunch(fixture, identityHost, "failed");

    const result = await fixture.engine.run();

    assert.equal(result.status, "failed");
    assert.equal(result.state.currentStep.attempt, 1);
    assert.equal(result.state.terminal.diagnostic.code, "fire-and-forget-early-exit");
    assert.equal(host.spawnCalls.length, 0);
  } finally {
    await fixture.cleanup();
  }
});

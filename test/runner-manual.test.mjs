import assert from "node:assert/strict";
import test from "node:test";

import {
  identifyRunnerPlan,
  RunnerConfigurationError,
  RunnerEngine,
  systemManualStepScheduler,
} from "@agent-boot/runner";

import {
  createEngineFixture,
  serializePlan,
} from "../test-support/runner-engine-helpers.mjs";

const exit = exitCode => ({ exitCode, reason: "exit", signal: null });

const manualStep = (marker = "fixture-value") => ({
  command: {
    arguments: [marker],
    executable: "manual-tool",
  },
  completionCheck: {
    arguments: [marker],
    executable: "check-tool",
  },
  id: "manual-gate",
  kind: "manual",
  pollIntervalSeconds: 1,
});

class ManualHost {
  activeForeground = false;
  foregroundCanceled = false;
  probeCommands = [];
  spawnCalls = [];
  #foregroundResult;
  #probeResults;
  #resolveForeground;

  constructor(probeResults, foregroundResult) {
    this.#probeResults = [...probeResults];
    this.#foregroundResult = foregroundResult;
  }

  spawn(command) {
    this.spawnCalls.push(command);
    if (command.executable === "check-tool") {
      this.probeCommands.push(command);
      const result = this.#probeResults.shift();
      if (result instanceof Error) throw result;
      assert.ok(result, "missing scripted completion-check result");
      return {
        cancel: () => undefined,
        completion: Promise.resolve(result),
        pid: undefined,
        sendSignal: () => false,
      };
    }

    assert.equal(command.executable, "manual-tool");
    this.activeForeground = true;
    let completion;
    if (this.#foregroundResult === undefined) {
      completion = new Promise(resolve => {
        this.#resolveForeground = resolve;
      });
    } else if (this.#foregroundResult instanceof Error) {
      completion = Promise.reject(this.#foregroundResult);
    } else {
      completion = Promise.resolve(this.#foregroundResult);
    }
    const trackedCompletion = completion.then(
      result => {
        this.activeForeground = false;
        return result;
      },
      error => {
        this.activeForeground = false;
        throw error;
      },
    );
    return {
      cancel: () => {
        this.foregroundCanceled = true;
        this.#resolveForeground?.({
          exitCode: null,
          reason: "canceled",
          signal: "SIGTERM",
        });
      },
      completion: trackedCompletion,
      pid: 4242,
      sendSignal: () => true,
    };
  }
}

class ImmediateScheduler {
  sleeps = [];

  sleep(delayMs, cancellation) {
    this.sleeps.push({ cancellation, delayMs });
    return Promise.resolve();
  }
}

class BlockingScheduler {
  pending = 0;
  sleeps = [];

  sleep(delayMs, cancellation) {
    this.sleeps.push({ cancellation, delayMs });
    this.pending += 1;
    return new Promise(resolve => {
      cancellation.addEventListener("abort", () => {
        this.pending -= 1;
        resolve();
      }, { once: true });
    });
  }
}

const prepareStartedGate = async fixture => {
  const identity = identifyRunnerPlan(
    { agentId: "test-agent", schemaVersion: 1 },
    fixture.serializedPlan,
  );
  await fixture.store.initialize(identity);
  await fixture.store.checkpointStep(identity, {
    attempt: 1,
    id: "manual-gate",
    index: 0,
    phase: "started",
  });
};

test("manual foreground owns the TTY while silent probes use bounded backoff", async () => {
  const marker = "never-print-this-value";
  const host = new ManualHost([exit(1), exit(1), exit(1), exit(0)]);
  const scheduler = new ImmediateScheduler();
  const progress = [];
  const fixture = await createEngineFixture([manualStep(marker)], {
    engineOptions: {
      manualPolicy: {
        completionCheckTimeoutMs: 321,
        maximumPollIntervalMs: 1_500,
      },
      manualScheduler: scheduler,
      onProgress: event => progress.push(event),
    },
    host,
  });
  try {
    const result = await fixture.engine.run();

    assert.equal(result.status, "succeeded");
    const foreground = host.spawnCalls.find(call => call.executable === "manual-tool");
    assert.equal(foreground.stdio, "inherit");
    assert.deepEqual(foreground.forwardSignals, ["SIGHUP", "SIGINT", "SIGTERM"]);
    assert.equal(foreground.timeoutMs, undefined);
    assert.equal(foreground.environment.HOME, "/home/my-user");
    assert.equal(foreground.cwd, "/home/my-user/workspace");
    assert.equal(host.foregroundCanceled, true);
    assert.equal(host.activeForeground, false);

    assert.equal(host.probeCommands.length, 4);
    for (const probe of host.probeCommands) {
      assert.equal(probe.stdio, "stream");
      assert.equal(probe.onOutput, undefined);
      assert.equal(probe.forwardSignals, undefined);
      assert.equal(probe.timeoutMs, 321);
      assert.deepEqual(probe.lifetime, { policy: "managed" });
    }
    assert.deepEqual(scheduler.sleeps.map(entry => entry.delayMs), [1_000, 1_500, 1_500]);
    assert.ok(scheduler.sleeps.every(entry => entry.cancellation.aborted));
    assert.deepEqual(
      progress.filter(event => event.status.startsWith("manual-")).map(event => event.status),
      [
        "manual-waiting",
        "manual-check-retry",
        "manual-check-retry",
        "manual-check-retry",
        "manual-completed",
      ],
    );
    assert.doesNotMatch(JSON.stringify({ progress, state: result.state }), new RegExp(marker, "u"));
  } finally {
    await fixture.cleanup();
  }
});

test("resume re-probes an in-progress gate and never infers completion", async () => {
  const host = new ManualHost([exit(1), exit(0)]);
  const scheduler = new ImmediateScheduler();
  const progress = [];
  const fixture = await createEngineFixture([manualStep()], {
    engineOptions: {
      manualScheduler: scheduler,
      onProgress: event => progress.push(event),
    },
    host,
  });
  try {
    await prepareStartedGate(fixture);

    const result = await fixture.engine.run();

    assert.equal(result.status, "succeeded");
    assert.equal(host.probeCommands.length, 2);
    assert.equal(host.spawnCalls.filter(call => call.executable === "manual-tool").length, 1);
    assert.equal(progress.find(event => event.status === "manual-waiting").resumed, true);
  } finally {
    await fixture.cleanup();
  }
});

test("resume checkpoints completion only after a successful probe", async () => {
  const host = new ManualHost([exit(0)]);
  const fixture = await createEngineFixture([manualStep()], { host });
  try {
    await prepareStartedGate(fixture);

    const result = await fixture.engine.run();

    assert.equal(result.status, "succeeded");
    assert.equal(host.spawnCalls.length, 1);
    assert.equal(host.spawnCalls[0].executable, "check-tool");
    assert.equal(result.state.currentStep.phase, "succeeded");
  } finally {
    await fixture.cleanup();
  }
});

for (const scenario of [
  {
    code: "manual-gate-incomplete",
    foreground: exit(0),
    name: "foreground exits before the gate completes",
  },
  {
    code: "manual-command-failed",
    foreground: exit(7),
    name: "foreground command fails",
  },
]) {
  test(`${scenario.name} becomes a redacted terminal failure`, async () => {
    const marker = "failure-secret-marker";
    const host = new ManualHost([exit(1), exit(1)], scenario.foreground);
    const scheduler = new BlockingScheduler();
    const progress = [];
    const fixture = await createEngineFixture([manualStep(marker)], {
      engineOptions: {
        manualScheduler: scheduler,
        onProgress: event => progress.push(event),
      },
      host,
    });
    try {
      const result = await fixture.engine.run();

      assert.equal(result.status, "failed");
      assert.equal(result.state.terminal.diagnostic.code, scenario.code);
      assert.equal(result.state.terminal.diagnostic.recovery, "manual-intervention");
      assert.ok(progress.some(event => event.status === "manual-terminal-failure"));
      assert.ok(scheduler.sleeps.every(entry => entry.cancellation.aborted));
      assert.equal(scheduler.pending, 0);
      assert.equal(host.activeForeground, false);
      assert.doesNotMatch(JSON.stringify({ progress, state: result.state }), new RegExp(marker, "u"));
    } finally {
      await fixture.cleanup();
    }
  });
}

test("a completion-check start failure never launches the foreground command", async () => {
  const marker = "probe-private-error";
  const host = new ManualHost([new Error(marker)]);
  const progress = [];
  const fixture = await createEngineFixture([manualStep()], {
    engineOptions: { onProgress: event => progress.push(event) },
    host,
  });
  try {
    const result = await fixture.engine.run();

    assert.equal(result.status, "failed");
    assert.equal(result.state.terminal.diagnostic.code, "manual-completion-check-failed");
    assert.equal(host.spawnCalls.length, 1);
    assert.doesNotMatch(JSON.stringify({ progress, state: result.state }), new RegExp(marker, "u"));
  } finally {
    await fixture.cleanup();
  }
});

test("a completion-check failure after launch cancels the foreground process", async () => {
  const marker = "late-probe-private-error";
  const host = new ManualHost([exit(1), new Error(marker)]);
  const scheduler = new ImmediateScheduler();
  const fixture = await createEngineFixture([manualStep()], {
    engineOptions: { manualScheduler: scheduler },
    host,
  });
  try {
    const result = await fixture.engine.run();

    assert.equal(result.status, "failed");
    assert.equal(result.state.terminal.diagnostic.code, "manual-completion-check-failed");
    assert.equal(host.foregroundCanceled, true);
    assert.equal(host.activeForeground, false);
    assert.ok(scheduler.sleeps.every(entry => entry.cancellation.aborted));
    assert.doesNotMatch(JSON.stringify(result.state), new RegExp(marker, "u"));
  } finally {
    await fixture.cleanup();
  }
});

test("manual polling configuration rejects unbounded values before state or process work", () => {
  const stateStore = {
    checkpointStep: () => assert.fail("must not checkpoint"),
    initialize: () => assert.fail("must not initialize"),
    markFailed: () => assert.fail("must not mark failed"),
    markSucceeded: () => assert.fail("must not mark succeeded"),
  };
  const base = {
    automaticPolicy: { maxAttempts: 1, timeoutMs: 1_000 },
    commandHost: new ManualHost([]),
    environment: {
      basePath: "/usr/bin",
      homeDirectory: "/home/my-user",
      workingDirectory: "/home/my-user",
    },
    serializedPlan: serializePlan([manualStep()]),
    stateStore,
  };

  assert.throws(
    () => new RunnerEngine({
      ...base,
      manualPolicy: { completionCheckTimeoutMs: 0, maximumPollIntervalMs: 1_000 },
    }),
    RunnerConfigurationError,
  );
  assert.throws(
    () => new RunnerEngine({
      ...base,
      manualPolicy: {
        completionCheckTimeoutMs: 1_000,
        maximumPollIntervalMs: 24 * 60 * 60 * 1_000 + 1,
      },
    }),
    RunnerConfigurationError,
  );
});

test("the system scheduler settles and clears an aborted long poll", async () => {
  const controller = new globalThis.AbortController();
  const sleeping = systemManualStepScheduler.sleep(24 * 60 * 60 * 1_000, controller.signal);

  controller.abort();

  await sleeping;
  assert.equal(controller.signal.aborted, true);
});

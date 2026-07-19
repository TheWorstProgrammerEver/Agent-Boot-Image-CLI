import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FakeCommandHost } from "@agent-boot/process";
import { RunnerEngine, RunnerStateStore, TestClock } from "@agent-boot/runner";

export const successfulSpawn = {
  result: { exitCode: 0, reason: "exit", signal: null },
};

export const serializePlan = steps =>
  `${JSON.stringify({
    agentId: "test-agent",
    providers: [],
    schemaVersion: 1,
    steps,
  })}\n`;

export const environmentStep = (id = "set-agent-name") => ({
  id,
  key: "AGENT_NAME",
  kind: "environment",
  operation: "set",
  value: "My Agent",
});

export const automaticStep = (id = "run-tool", command = {}) => ({
  command: {
    arguments: ["--fixture"],
    executable: "fixture-tool",
    ...command,
  },
  id,
  kind: "automatic",
});

export const createEngineFixture = async (steps, options = {}) => {
  const root = await mkdtemp(join(tmpdir(), "agent-boot-runner-engine-"));
  const path = join(root, "state", "runner-checkpoint.json");
  const serializedPlan = serializePlan(steps);
  const host = options.host ?? new FakeCommandHost();
  const store = options.store ?? new RunnerStateStore({
    clock: new TestClock("2026-07-19T00:00:00.000Z"),
    path,
  });
  const engineOptions = {
    automaticPolicy: { maxAttempts: 3, timeoutMs: 60_000 },
    commandHost: host,
    environment: {
      basePath: "/opt/agent/bin:/usr/bin",
      homeDirectory: "/home/my-user",
      workingDirectory: "/home/my-user/workspace",
    },
    manualPolicy: {
      completionCheckTimeoutMs: 5_000,
      maximumPollIntervalMs: 8_000,
    },
    serializedPlan,
    stateStore: store,
    ...options.engineOptions,
  };
  return {
    cleanup: () => rm(root, { force: true, recursive: true }),
    createEngine: overrides => new RunnerEngine({ ...engineOptions, ...overrides }),
    engine: new RunnerEngine(engineOptions),
    host,
    path,
    root,
    serializedPlan,
    store,
  };
};

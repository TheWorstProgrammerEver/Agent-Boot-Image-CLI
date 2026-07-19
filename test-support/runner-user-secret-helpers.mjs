import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getgid, getuid } from "node:process";
import { Buffer } from "node:buffer";

import {
  InstallUserSecretExecutor,
  RunnerEngine,
  RunnerStateStore,
  TestClock,
  identifyRunnerPlan,
} from "@agent-boot/runner";

import { serializePlan } from "./runner-engine-helpers.mjs";

export const secretContents = Buffer.from("private fixture credential\n", "utf8");

export const userSecretStep = (overrides = {}) => ({
  destination: ".config/service/credential",
  id: "install-service-credential",
  kind: "install-user-secret",
  secretId: "service-credential",
  ...overrides,
});

export const createUserSecretFixture = async (options = {}) => {
  const root = await mkdtemp(join(tmpdir(), "agent-boot-user-secret-"));
  const home = join(root, "home", "my-user");
  const bootstrap = join(root, "etc", "agent-boot", "bootstrap-secrets");
  const source = join(bootstrap, "service-credential");
  const statePath = join(root, "var", "lib", "agent-boot", "runner-checkpoint.json");
  await mkdir(home, { recursive: true });
  await mkdir(bootstrap, { recursive: true });
  if (options.createSource !== false) await writeFile(source, secretContents, { mode: 0o600 });

  const step = userSecretStep(options.step);
  const serializedPlan = serializePlan([step]);
  const identity = identifyRunnerPlan(
    { agentId: "test-agent", schemaVersion: 1 },
    serializedPlan,
  );
  const store = new RunnerStateStore({
    clock: new TestClock("2026-07-19T00:00:00.000Z"),
    path: statePath,
  });
  const accountUid = getuid();
  const accountGid = getgid();
  const userSecretInstallation = {
    accountGid,
    accountUid,
    systemRoot: root,
    ...options.userSecretInstallation,
  };
  const engineOptions = {
    automaticPolicy: { maxAttempts: 1, timeoutMs: 1_000 },
    commandHost: {
      spawn: () => {
        throw new Error("user-secret tests must not spawn commands");
      },
    },
    environment: {
      basePath: "/usr/bin",
      homeDirectory: home,
      workingDirectory: home,
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
    serializedPlan,
    stateStore: store,
    userSecretInstallation,
    ...options.engineOptions,
  };
  return {
    accountGid,
    accountUid,
    bootstrap,
    cleanup: () => rm(root, { force: true, recursive: true }),
    createEngine: overrides => new RunnerEngine({ ...engineOptions, ...overrides }),
    createExecutor: overrides =>
      new InstallUserSecretExecutor({
        accountGid,
        accountHome: home,
        accountUid,
        systemRoot: root,
        ...overrides,
      }),
    destination: join(home, ".config", "service", "credential"),
    engine: new RunnerEngine(engineOptions),
    home,
    identity,
    root,
    serializedPlan,
    source,
    statePath,
    step,
    store,
  };
};

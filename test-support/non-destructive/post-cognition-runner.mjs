import process from "node:process";

import {
  AssemblyResourceResolver,
  EphemeralPromptStore,
  PromptHydrator,
  RunnerEngine,
} from "@agent-boot/runner";
import { createCodexProviderAdapter } from "@agent-boot/runner-bundle";

export const createPostCognitionEngine = ({
  commandHost,
  fixture,
  identityHost,
  onProgress,
  stateStore = fixture.store,
}) => {
  const promptHydrator = new PromptHydrator(
    new AssemblyResourceResolver(fixture.resourceRoot, fixture.manifest),
    { resolve: async () => { throw new Error("Unexpected prompt secret request"); } },
    new EphemeralPromptStore(fixture.plan.agentId, { systemRoot: fixture.systemRoot }),
  );
  const providerAdapter = createCodexProviderAdapter({
    commandHost,
    gid: process.getgid(),
    homeDirectory: fixture.homeDirectory,
    plan: fixture.plan,
    uid: process.getuid(),
  });
  if (providerAdapter === undefined) throw new Error("Expected Codex provider adapter");

  return new RunnerEngine({
    automaticPolicy: { maxAttempts: 3, timeoutMs: 60_000 },
    commandHost,
    environment: {
      basePath: "/opt/agent-boot/scripts/bin:/opt/agent-boot/runtime/bin:/usr/bin",
      homeDirectory: fixture.homeDirectory,
      workingDirectory: fixture.workingDirectory,
    },
    fireAndForgetPolicy: {
      acceptanceWindowMs: 10,
      maxLaunchAttempts: 3,
      terminationGraceMs: 100,
    },
    lifecycleWait: async () => undefined,
    manualPolicy: {
      completionCheckTimeoutMs: 5_000,
      maximumPollIntervalMs: 8_000,
    },
    manualScheduler: { sleep: async () => undefined },
    onProgress,
    processIdentityHost: identityHost,
    promptHydrator,
    providerAdapter,
    providerPolicy: { timeoutMs: 60_000 },
    serializedPlan: fixture.serializedPlan,
    stateStore,
    userSecretInstallation: {
      accountGid: process.getgid(),
      accountUid: process.getuid(),
      systemRoot: fixture.systemRoot,
    },
  });
};

import { readFile } from "node:fs/promises";

import { NodeSpawnAdapter } from "@agent-boot/process";
import { manifestSchema, runnerPlanSchema } from "@agent-boot/protocol";
import {
  AssemblyResourceResolver,
  EphemeralPromptStore,
  PromptHydrator,
  RunnerEngine,
  RunnerStateStore,
} from "@agent-boot/runner";

import { TARGET_PATHS } from "../paths.js";
import { RuntimeCommandHost } from "./command-host.js";
import { createCodexProviderAdapter } from "./codex.js";
import { formatRunnerProgress } from "./progress.js";
import { RuntimeSecretResolver } from "./secret-resolver.js";

const parseDocument = async (path: string): Promise<unknown> =>
  JSON.parse(await readFile(path, "utf8")) as unknown;

const signalController = (): { controller: AbortController; dispose: () => void } => {
  const controller = new AbortController();
  const listeners = new Map<NodeJS.Signals, () => void>();
  for (const signal of ["SIGHUP", "SIGINT", "SIGTERM"] as const) {
    const listener = (): void => {
      controller.abort(signal);
    };
    listeners.set(signal, listener);
    process.on(signal, listener);
  }
  return {
    controller,
    dispose: () => {
      for (const [signal, listener] of listeners) process.off(signal, listener);
    },
  };
};

const run = async (): Promise<"failed" | "succeeded"> => {
  const uid = process.getuid?.();
  const gid = process.getgid?.();
  const homeDirectory = process.env.HOME;
  const basePath = process.env.PATH;
  const workingDirectory = process.env.AGENT_BOOT_WORKING_DIRECTORY;
  if (
    uid === undefined || gid === undefined || homeDirectory === undefined ||
    basePath === undefined || workingDirectory === undefined
  ) {
    throw new Error("Runner account context is unavailable.");
  }

  const manifest = manifestSchema.parse(await parseDocument(TARGET_PATHS.assemblyManifest));
  const serializedPlan = await readFile(TARGET_PATHS.plan);
  const plan = runnerPlanSchema.parse(JSON.parse(serializedPlan.toString("utf8")) as unknown);
  if (manifest.agent.id !== plan.agentId) throw new Error("Assembly identity mismatch.");

  const commandHost = new RuntimeCommandHost(
    new NodeSpawnAdapter({ terminationGraceMs: 5_000 }),
  );
  const resources = new AssemblyResourceResolver(TARGET_PATHS.immutableRoot, manifest);
  const promptHydrator = new PromptHydrator(
    resources,
    new RuntimeSecretResolver(TARGET_PATHS.ephemeralSecrets),
    new EphemeralPromptStore(plan.agentId),
  );
  const providerAdapter = createCodexProviderAdapter({
    commandHost,
    gid,
    homeDirectory,
    plan,
    uid,
  });
  const cancellation = signalController();
  try {
    const engine = new RunnerEngine({
      automaticPolicy: { maxAttempts: 3, timeoutMs: 24 * 60 * 60 * 1_000 },
      cancellation: cancellation.controller.signal,
      commandHost,
      environment: { basePath, homeDirectory, workingDirectory },
      fireAndForgetPolicy: {
        acceptanceWindowMs: 1_000,
        maxLaunchAttempts: 3,
        terminationGraceMs: 5_000,
      },
      manualPolicy: {
        completionCheckTimeoutMs: 30_000,
        maximumPollIntervalMs: 30_000,
      },
      onProgress: progress => process.stdout.write(formatRunnerProgress(progress)),
      promptHydrator,
      ...(providerAdapter === undefined
        ? {}
        : { providerAdapter, providerPolicy: { timeoutMs: 24 * 60 * 60 * 1_000 } }),
      serializedPlan,
      stateStore: new RunnerStateStore({ path: TARGET_PATHS.state }),
      userSecretInstallation: { accountGid: gid, accountUid: uid },
    });
    return (await engine.run()).status;
  } finally {
    cancellation.dispose();
  }
};

export const runRunnerService = async (): Promise<void> => {
  try {
    if (await run() === "failed") process.exitCode = 1;
  } catch {
    process.stderr.write("agent-boot: runner failed before a terminal checkpoint\n");
    process.exitCode = 1;
  }
};

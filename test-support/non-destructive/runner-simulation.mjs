import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";

import {
  AssemblyResourceResolver,
  EphemeralPromptStore,
  PromptHydrator,
  RunnerEngine,
  RunnerStateStore,
} from "@agent-boot/runner";
import { runnerPlanSchema } from "@agent-boot/protocol";
import { createCodexProviderAdapter } from "@agent-boot/runner-bundle";

import {
  FakeProcessIdentityHost,
  IntegrationCommandHost,
} from "./fake-command-host.mjs";

class RebootCheckpointStore {
  #interrupted = new Set();

  constructor(store, interruptions, onSecretPhase) {
    this.store = store;
    this.interruptions = interruptions === undefined
      ? []
      : Array.isArray(interruptions) ? interruptions : [interruptions];
    this.onSecretPhase = onSecretPhase;
  }

  initialize(...arguments_) {
    return this.store.initialize(...arguments_);
  }

  markFailed(...arguments_) {
    return this.store.markFailed(...arguments_);
  }

  markSucceeded(...arguments_) {
    return this.store.markSucceeded(...arguments_);
  }

  checkpointFireAndForgetProcess(...arguments_) {
    return this.store.checkpointFireAndForgetProcess(...arguments_);
  }

  async checkpointSecretTransaction(...arguments_) {
    const state = await this.store.checkpointSecretTransaction(...arguments_);
    this.onSecretPhase?.(arguments_[1].phase);
    this.#interrupt("secret", arguments_[1]);
    return state;
  }

  async checkpointStep(...arguments_) {
    const state = await this.store.checkpointStep(...arguments_);
    this.#interrupt("step", arguments_[1]);
    return state;
  }

  #interrupt(kind, checkpoint) {
    const interruption = this.interruptions.find(candidate =>
      kind === candidate.kind &&
      checkpoint.phase === candidate.phase &&
      (candidate.id === undefined || checkpoint.id === candidate.id));
    if (interruption === undefined) return;
    const key = `${kind}:${interruption.id ?? interruption.phase}`;
    if (this.#interrupted.has(key)) return;
    this.#interrupted.add(key);
    throw new Error(`simulated reboot at ${kind} ${checkpoint.phase}`);
  }
}

const absent = path => assert.rejects(access(path), error => error.code === "ENOENT");

export const simulateRunnerReboots = async ({ privateMarker, systemRoot }) => {
  const manifest = JSON.parse(await readFile(
    join(systemRoot, "etc", "agent-boot", "manifest.json"),
    "utf8",
  ));
  const serializedPlan = await readFile(
    join(systemRoot, "etc", "agent-boot", "plan.json"),
  );
  const plan = runnerPlanSchema.parse(JSON.parse(serializedPlan.toString("utf8")));
  const statePath = join(systemRoot, "var", "lib", "agent-boot", "state.json");
  const baseStore = new RunnerStateStore({ path: statePath });
  const homeDirectory = join(systemRoot, "home", "my-user");
  const workingDirectory = join(homeDirectory, "workspace");
  const progress = [];
  const secretPhases = [];
  const hosts = [];
  const interruptions = [
    { id: "codex-verify-version", kind: "step", phase: "succeeded" },
    { id: "codex-authenticate-device", kind: "step", phase: "succeeded" },
    { id: "start-agent-support-service", kind: "step", phase: "succeeded" },
    [
      { kind: "secret", phase: "installed" },
      { id: "render-bootstrap-prompt", kind: "step", phase: "succeeded" },
    ],
  ];

  const createEngine = (index, interruption) => {
    const identityHost = new FakeProcessIdentityHost(
      `${String(index + 1).padStart(8, "0")}-1111-4111-8111-111111111111`,
    );
    const commandHost = new IntegrationCommandHost(identityHost);
    hosts.push(commandHost);
    const resources = new AssemblyResourceResolver(
      join(systemRoot, "opt", "agent-boot"),
      manifest,
    );
    const promptHydrator = new PromptHydrator(
      resources,
      { resolve: async () => { throw new Error("Unexpected prompt secret request"); } },
      new EphemeralPromptStore(plan.agentId, { systemRoot }),
    );
    const providerAdapter = createCodexProviderAdapter({
      commandHost,
      gid: process.getgid(),
      homeDirectory,
      plan,
      uid: process.getuid(),
    });
    assert.ok(providerAdapter);
    return new RunnerEngine({
      automaticPolicy: { maxAttempts: 3, timeoutMs: 60_000 },
      commandHost,
      environment: {
        basePath: "/opt/agent-boot/scripts/bin:/opt/agent-boot/runtime/bin:/usr/bin",
        homeDirectory,
        workingDirectory,
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
      onProgress: event => progress.push(event),
      processIdentityHost: identityHost,
      promptHydrator,
      providerAdapter,
      providerPolicy: { timeoutMs: 60_000 },
      serializedPlan,
      stateStore: new RebootCheckpointStore(
        baseStore,
        interruption,
        phase => secretPhases.push(phase),
      ),
      userSecretInstallation: {
        accountGid: process.getgid(),
        accountUid: process.getuid(),
        systemRoot,
      },
    });
  };

  try {
    for (const [index, interruption] of interruptions.entries()) {
      const label = (Array.isArray(interruption) ? interruption : [interruption])
        .map(candidate => `${candidate.kind}:${candidate.id ?? candidate.phase}`)
        .join(",");
      await assert.rejects(
        createEngine(index, interruption).run(),
        /simulated reboot/u,
        `runner did not stop at ${label}`,
      );
      assert.equal(hosts[index].activeCount, 0);
    }
    const result = await createEngine(interruptions.length).run();
    assert.equal(result.status, "succeeded");
    assert.equal(result.state.terminal?.status, "succeeded");
    assert.deepEqual(secretPhases, ["prepared", "installed", "source-removed", "committed"]);

    const calls = hosts.flatMap(host => host.spawnCalls);
    assert.ok(calls.some(call => call.label === "runner step codex-install"));
    assert.ok(calls.some(call => call.stdio === "inherit"));
    assert.ok(calls.filter(
      call => call.label === "runner step start-agent-support-service",
    ).length >= 2);
    assert.ok(calls.some(call => call.label === "runner provider codex step run-codex-bootstrap"));
    assert.ok(hosts.flatMap(host => host.execCalls).some(
      call => call.executable === "codex" && call.arguments?.join(" ") === "--version",
    ));
    const expectedPrompt = (await readFile(
      join(systemRoot, "opt", "agent-boot", "prompts", "bootstrap-agent"),
      "utf8",
    )).replace("{{agent-name}}", "My Agent");
    assert.deepEqual(hosts.flatMap(host => host.providerPrompts), [expectedPrompt]);

    const destination = join(homeDirectory, ".config", "repository", "credential");
    assert.equal(
      await readFile(destination, "utf8"),
      `${privateMarker}-repository-credential\n`,
    );
    await absent(join(
      systemRoot,
      "etc",
      "agent-boot",
      "bootstrap-secrets",
      "repository-credential",
    ));
    await absent(join(
      systemRoot,
      "run",
      "agent-boot",
      "prompts",
      "my-agent",
      "bootstrap-prompt.md",
    ));

    return { progress, secretPhases, state: result.state, statePath };
  } finally {
    for (const host of hosts) host.cancelAll();
    assert.ok(hosts.every(host => host.activeCount === 0));
  }
};

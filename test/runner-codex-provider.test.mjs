import assert from "node:assert/strict";
import test from "node:test";
import { TextEncoder } from "node:util";

import {
  ProviderStepExecutor,
  RunnerEnvironment,
} from "@agent-boot/runner";
import {
  CodexBootstrapError,
  CodexProviderAdapter,
} from "@agent-boot/runner/providers/codex";

const success = { exitCode: 0, reason: "exit", signal: null };
const descriptor = {
  command: {
    arguments: [
      "exec", "--profile", "agent-boot", "--strict-config",
      "--sandbox", "danger-full-access", "--ask-for-approval", "never", "-",
    ],
    executable: "codex",
    workingDirectory: { path: "workspace", scope: "user-home" },
  },
  id: "codex",
  promptTransport: "stdin",
};
const adapterInput = {
  cwd: "/home/my-user/workspace",
  descriptor,
  environment: { HOME: "/home/my-user", PATH: "/usr/bin" },
  step: { id: "run-codex", kind: "provider", providerId: "codex", renderedPromptId: "prompt" },
  timeoutMs: 60_000,
};

class ProviderHost {
  events = [];

  spawn(command) {
    this.events.push(`spawn:${command.executable}:${(command.arguments ?? []).join(" ")}`);
    return {
      cancel: () => undefined,
      completion: Promise.resolve(success),
      pid: undefined,
      sendSignal: () => false,
    };
  }
}

test("provider readiness runs before prompt hydration and retries without leaking failures", async () => {
  const marker = "private-gate-error";
  let gateAttempts = 0;
  let hydrationCalls = 0;
  const adapter = new CodexProviderAdapter({
    ensureReady: async () => {
      gateAttempts += 1;
      if (gateAttempts === 1) throw new Error(marker);
    },
  });
  const host = new ProviderHost();
  const hydrator = {
    hydrate: async () => {
      hydrationCalls += 1;
      return { contents: new TextEncoder().encode("private prompt") };
    },
    remove: async () => undefined,
  };
  const executor = new ProviderStepExecutor(
    host,
    new RunnerEnvironment({
      basePath: "/usr/bin",
      homeDirectory: "/home/my-user",
      workingDirectory: "/home/my-user/workspace",
    }),
    hydrator,
    adapter,
    { timeoutMs: 60_000 },
  );
  const promptStep = {
    id: "render-prompt",
    kind: "prompt",
    renderedPromptId: "prompt",
    retention: "ephemeral",
    templateId: "template",
    variables: [],
  };

  const first = await executor.execute(
    adapterInput.step,
    descriptor,
    promptStep,
    { promptEnvironment: adapterInput.environment, providerEnvironment: adapterInput.environment },
  );
  assert.equal(first.status, "failed");
  assert.equal(hydrationCalls, 0);
  assert.equal(host.events.length, 0);
  assert.doesNotMatch(JSON.stringify(first), new RegExp(marker, "u"));

  const second = await executor.execute(
    adapterInput.step,
    descriptor,
    promptStep,
    { promptEnvironment: adapterInput.environment, providerEnvironment: adapterInput.environment },
  );
  assert.equal(second.status, "succeeded");
  assert.equal(hydrationCalls, 1);
  assert.equal(host.events.at(-1), "spawn:codex:exec --profile agent-boot --strict-config --sandbox danger-full-access --ask-for-approval never -");
});

test("Codex adapter rejects an implicit working root before consulting readiness", async () => {
  let gateCalled = false;
  const adapter = new CodexProviderAdapter({
    ensureReady: async () => { gateCalled = true; },
  });
  const implicitRoot = {
    ...adapterInput,
    descriptor: {
      ...descriptor,
      command: {
        arguments: descriptor.command.arguments,
        executable: descriptor.command.executable,
      },
    },
  };

  await assert.rejects(
    adapter.prepare(implicitRoot),
    error => error instanceof CodexBootstrapError && error.stage === "configuration",
  );
  assert.equal(gateCalled, false);
});

test("Codex invocation clears inherited CODEX_HOME and uses concrete permission flags", () => {
  const adapter = new CodexProviderAdapter({ ensureReady: async () => undefined });
  const command = adapter.createProcess({
    ...adapterInput,
    environment: {
      ...adapterInput.environment,
      CODEX_HOME: "/untrusted/inherited-home",
    },
    prompt: new TextEncoder().encode("prompt"),
  });

  assert.equal(command.environment.CODEX_HOME, undefined);
  assert.deepEqual(command.arguments, descriptor.command.arguments);
  assert.equal(command.cwd, adapterInput.cwd);
});

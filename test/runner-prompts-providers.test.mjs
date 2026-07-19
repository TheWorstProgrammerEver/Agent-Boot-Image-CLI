import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, mkdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { mkdtemp } from "node:fs/promises";
import test from "node:test";
import { TextDecoder, TextEncoder } from "node:util";

import { FakeCommandHost } from "@agent-boot/process";
import {
  AssemblyResourceResolver,
  CodexProviderAdapter,
  EphemeralPromptStore,
  PromptHydrationError,
  PromptHydrator,
  renderTemplate,
} from "@agent-boot/runner";

import {
  createEngineFixture,
  environmentStep,
  successfulSpawn,
} from "../test-support/runner-engine-helpers.mjs";

const digest = contents => createHash("sha256").update(contents).digest("hex");

const manifestFor = (promptContents, overrides = {}) => ({
  assets: [{
    byteLength: 5,
    id: "runtime-asset",
    path: "assets/runtime.txt",
    sha256: digest("asset"),
  }],
  prompts: [{
    id: "bootstrap-template",
    path: "prompts/bootstrap.md",
    sha256: digest(promptContents),
    variables: ["agent-name", "private-value"],
    ...overrides,
  }],
});

const createPromptFixture = async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-boot-prompts-"));
  const assemblyRoot = join(root, "assembly");
  const systemRoot = join(root, "system-root");
  const template = "Agent={{agent-name}}\nSecret={{private-value}}\n";
  await mkdir(join(assemblyRoot, "assets"), { recursive: true });
  await mkdir(join(assemblyRoot, "prompts"), { recursive: true });
  await writeFile(join(assemblyRoot, "assets", "runtime.txt"), "asset");
  await writeFile(join(assemblyRoot, "prompts", "bootstrap.md"), template);
  const manifest = manifestFor(template);
  const resources = new AssemblyResourceResolver(assemblyRoot, manifest);
  const store = new EphemeralPromptStore("test-agent", { systemRoot });
  return {
    assemblyRoot,
    cleanup: () => rm(root, { force: true, recursive: true }),
    manifest,
    resources,
    root,
    store,
    systemRoot,
    template,
  };
};

const promptStep = {
  id: "render-bootstrap",
  kind: "prompt",
  renderedPromptId: "bootstrap-rendered",
  retention: "ephemeral",
  templateId: "bootstrap-template",
  variables: [
    { name: "agent-name", source: { key: "AGENT_NAME", kind: "environment" } },
    { name: "private-value", source: { kind: "secret", secretId: "bootstrap-secret" } },
  ],
};

const providerStep = {
  id: "run-codex",
  kind: "provider",
  providerId: "codex",
  renderedPromptId: "bootstrap-rendered",
};

const codexProvider = {
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

const readyCodexAdapter = () => new CodexProviderAdapter({
  ensureReady: async () => undefined,
});

const renderedPath = fixture => join(
  fixture.systemRoot,
  "run",
  "agent-boot",
  "prompts",
  "test-agent",
  "bootstrap-rendered.md",
);

test("template hydration replaces declared tokens and rejects unresolved syntax", () => {
  const values = new Map([
    ["agent-name", "My Agent"],
    ["private-value", "value with {{literal braces}}"],
  ]);
  assert.equal(
    renderTemplate("{{agent-name}}:{{private-value}}", values),
    "My Agent:value with {{literal braces}}",
  );
  assert.throws(
    () => renderTemplate("{{missing}}", values, "bootstrap-template"),
    error => error instanceof PromptHydrationError && error.reason === "missing-substitution",
  );
  assert.throws(
    () => renderTemplate("{{agent-name", new Map([["agent-name", "value"]])),
    PromptHydrationError,
  );
});

test("assembly resources resolve by identifier and reject traversal, symlinks, and digest drift", async () => {
  const fixture = await createPromptFixture();
  try {
    assert.equal(new TextDecoder().decode(await fixture.resources.resolveAsset("runtime-asset")), "asset");
    assert.equal(
      new TextDecoder().decode((await fixture.resources.resolvePrompt("bootstrap-template")).contents),
      fixture.template,
    );
    await assert.rejects(
      fixture.resources.resolvePrompt("missing-template"),
      error => error instanceof PromptHydrationError && error.reason === "missing-resource",
    );

    const traversal = new AssemblyResourceResolver(
      fixture.assemblyRoot,
      manifestFor(fixture.template, { path: "prompts/../outside.md" }),
    );
    await assert.rejects(
      traversal.resolvePrompt("bootstrap-template"),
      error => error instanceof PromptHydrationError && error.reason === "unsafe-resource",
    );

    const outside = join(fixture.root, "outside.md");
    await writeFile(outside, fixture.template);
    const linked = join(fixture.assemblyRoot, "prompts", "linked.md");
    await symlink(outside, linked);
    const symlinked = new AssemblyResourceResolver(
      fixture.assemblyRoot,
      manifestFor(fixture.template, { path: "prompts/linked.md" }),
    );
    await assert.rejects(
      symlinked.resolvePrompt("bootstrap-template"),
      error => error instanceof PromptHydrationError && error.reason === "unsafe-resource",
    );

    await writeFile(join(fixture.assemblyRoot, "prompts", "bootstrap.md"), "changed");
    await assert.rejects(
      fixture.resources.resolvePrompt("bootstrap-template"),
      error => error instanceof PromptHydrationError && error.reason === "invalid-resource",
    );
  } finally {
    await fixture.cleanup();
  }
});

test("secret-bearing prompts use the logical runtime root and restrictive permissions", async () => {
  const marker = "private-bootstrap-marker";
  const fixture = await createPromptFixture();
  const hydrator = new PromptHydrator(
    fixture.resources,
    { resolve: async () => marker },
    fixture.store,
  );
  try {
    await hydrator.hydrate(promptStep, { AGENT_NAME: "My Agent" });
    const path = renderedPath(fixture);
    assert.match(path, /\/run\/agent-boot\/prompts\/test-agent\/bootstrap-rendered\.md$/u);
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    for (const directory of [
      dirname(path),
      dirname(dirname(path)),
      dirname(dirname(dirname(path))),
    ]) {
      assert.equal((await stat(directory)).mode & 0o777, 0o700);
    }
    assert.equal((await readFile(path, "utf8")), `Agent=My Agent\nSecret=${marker}\n`);

    await hydrator.remove(promptStep.renderedPromptId);
    await assert.rejects(access(path));
  } finally {
    await fixture.cleanup();
  }
});

test("ephemeral storage rejects traversal and a symlinked runtime boundary", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-boot-runtime-boundary-"));
  const systemRoot = join(root, "system-root");
  const outside = join(root, "outside");
  await mkdir(join(systemRoot, "run"), { recursive: true });
  await mkdir(outside);
  await symlink(outside, join(systemRoot, "run", "agent-boot"));
  const store = new EphemeralPromptStore("test-agent", { systemRoot });
  try {
    await assert.rejects(
      store.write("../escaped", new TextEncoder().encode("private")),
      PromptHydrationError,
    );
    await assert.rejects(
      store.write("rendered", new TextEncoder().encode("private")),
      error => error instanceof PromptHydrationError && error.reason === "write-failed",
    );
    await assert.rejects(access(join(outside, "prompts")));
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("provider execution regenerates the producer snapshot after reboot", async () => {
  const marker = "private-reboot-marker";
  const progress = [];
  const promptFixture = await createPromptFixture();
  let resolutions = 0;
  const hydrator = new PromptHydrator(
    promptFixture.resources,
    {
      resolve: async () => {
        resolutions += 1;
        return marker;
      },
    },
    promptFixture.store,
  );
  const host = new FakeCommandHost();
  const changedEnvironment = {
    id: "change-agent-name",
    key: "AGENT_NAME",
    kind: "environment",
    operation: "set",
    value: "Changed Agent",
  };
  const unsetEnvironment = {
    id: "unset-agent-name",
    key: "AGENT_NAME",
    kind: "environment",
    operation: "unset",
  };
  const fixture = await createEngineFixture(
    [
      environmentStep(),
      promptStep,
      changedEnvironment,
      unsetEnvironment,
      providerStep,
    ],
    {
      engineOptions: {
        automaticPolicy: { maxAttempts: 1, timeoutMs: 60_000 },
        onProgress: event => progress.push(event),
        promptHydrator: hydrator,
        providerAdapter: readyCodexAdapter(),
        providerPolicy: { timeoutMs: 120_000 },
      },
      host,
      providers: [codexProvider],
    },
  );
  try {
    const interruptedStore = {
      checkpointStep: async (plan, checkpoint) => {
        const state = await fixture.store.checkpointStep(plan, checkpoint);
        if (checkpoint.id === promptStep.id && checkpoint.phase === "succeeded") {
          throw new Error("simulated reboot");
        }
        return state;
      },
      initialize: plan => fixture.store.initialize(plan),
      markFailed: (plan, diagnostic) => fixture.store.markFailed(plan, diagnostic),
      markSucceeded: plan => fixture.store.markSucceeded(plan),
    };
    await assert.rejects(
      fixture.createEngine({ stateStore: interruptedStore }).run(),
      /simulated reboot/u,
    );
    assert.equal(host.spawnCalls.length, 0);
    await assert.rejects(access(renderedPath(promptFixture)));

    host.scriptSpawnResult({
      output: [{ data: new TextEncoder().encode("provider-private-output"), stream: "stdout" }],
      ...successfulSpawn,
    });
    const result = await fixture.engine.run();

    assert.equal(result.status, "succeeded");
    assert.equal(resolutions, 2);
    assert.equal(host.spawnCalls.length, 1);
    const call = host.spawnCalls[0];
    assert.equal(call.cwd, "/home/my-user/workspace");
    assert.equal(call.environment.HOME, "/home/my-user");
    assert.equal(call.environment.PATH, "/opt/agent/bin:/usr/bin");
    assert.equal(call.environment.AGENT_NAME, undefined);
    assert.equal(new TextDecoder().decode(call.stdin), `Agent=My Agent\nSecret=${marker}\n`);
    assert.equal(call.stdio, "stream");
    assert.equal(call.timeoutMs, 120_000);
    assert.deepEqual(call.lifetime, { policy: "managed" });
    await assert.rejects(access(renderedPath(promptFixture)));

    const observable = JSON.stringify({ progress, state: result.state });
    assert.doesNotMatch(observable, new RegExp(marker, "u"));
    assert.doesNotMatch(observable, /provider-private-output/u);
    assert.doesNotMatch(observable, /stdin|arguments|environment/u);
    assert.doesNotMatch(observable, /\/run\/agent-boot/u);
  } finally {
    await fixture.cleanup();
    await promptFixture.cleanup();
  }
});

test("missing substitutions fail before provider launch with redacted diagnostics", async () => {
  const marker = "secret-resolver-exception-marker";
  const progress = [];
  const promptFixture = await createPromptFixture();
  const hydrator = new PromptHydrator(
    promptFixture.resources,
    { resolve: async () => { throw new Error(marker); } },
    promptFixture.store,
  );
  const fixture = await createEngineFixture([environmentStep(), promptStep, providerStep], {
    engineOptions: {
      automaticPolicy: { maxAttempts: 1, timeoutMs: 60_000 },
      onProgress: event => progress.push(event),
      promptHydrator: hydrator,
      providerAdapter: readyCodexAdapter(),
      providerPolicy: { timeoutMs: 120_000 },
    },
    providers: [codexProvider],
  });
  try {
    const result = await fixture.engine.run();
    assert.equal(result.status, "failed");
    assert.equal(fixture.host.spawnCalls.length, 0);
    assert.equal(result.state.terminal.diagnostic.code, "prompt-hydration-failed");
    const observable = JSON.stringify({ progress, state: result.state });
    assert.doesNotMatch(observable, new RegExp(marker, "u"));
    assert.doesNotMatch(observable, /message|secretId|private-value/u);
  } finally {
    await fixture.cleanup();
    await promptFixture.cleanup();
  }
});

test("a missing assembly template fails before provider launch", async () => {
  const promptFixture = await createPromptFixture();
  await rm(join(promptFixture.assemblyRoot, "prompts", "bootstrap.md"));
  const hydrator = new PromptHydrator(
    promptFixture.resources,
    { resolve: async () => "private" },
    promptFixture.store,
  );
  const fixture = await createEngineFixture([promptStep, providerStep], {
    engineOptions: {
      automaticPolicy: { maxAttempts: 1, timeoutMs: 60_000 },
      promptHydrator: hydrator,
      providerAdapter: readyCodexAdapter(),
      providerPolicy: { timeoutMs: 120_000 },
    },
    providers: [codexProvider],
  });
  try {
    const result = await fixture.engine.run();
    assert.equal(result.status, "failed");
    assert.equal(fixture.host.spawnCalls.length, 0);
    assert.equal(result.state.terminal.diagnostic.code, "prompt-hydration-failed");
  } finally {
    await fixture.cleanup();
    await promptFixture.cleanup();
  }
});

test("provider failure remains redacted and removes the ephemeral prompt", async () => {
  const secret = "provider-failure-private-marker";
  const output = "provider-output-private-marker";
  const progress = [];
  const promptFixture = await createPromptFixture();
  const host = new FakeCommandHost().scriptSpawnResult({
    output: [{ data: new TextEncoder().encode(output), stream: "stderr" }],
    result: { exitCode: 17, reason: "exit", signal: null },
  });
  const fixture = await createEngineFixture([environmentStep(), promptStep, providerStep], {
    engineOptions: {
      automaticPolicy: { maxAttempts: 1, timeoutMs: 60_000 },
      onProgress: event => progress.push(event),
      promptHydrator: new PromptHydrator(
        promptFixture.resources,
        { resolve: async () => secret },
        promptFixture.store,
      ),
      providerAdapter: readyCodexAdapter(),
      providerPolicy: { timeoutMs: 120_000 },
    },
    host,
    providers: [codexProvider],
  });
  try {
    const result = await fixture.engine.run();
    assert.equal(result.status, "failed");
    assert.equal(result.state.terminal.diagnostic.code, "provider-execution-failed");
    assert.equal(result.state.terminal.diagnostic.exitCode, 17);
    await assert.rejects(access(renderedPath(promptFixture)));
    const observable = JSON.stringify({ progress, state: result.state });
    assert.doesNotMatch(observable, new RegExp(secret, "u"));
    assert.doesNotMatch(observable, new RegExp(output, "u"));
  } finally {
    await fixture.cleanup();
    await promptFixture.cleanup();
  }
});

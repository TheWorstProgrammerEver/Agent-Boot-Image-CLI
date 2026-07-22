import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";
import test from "node:test";

import {
  PostCognitionCommandHost,
  PostCognitionIdentityHost,
} from "../../../test-support/non-destructive/post-cognition-command-host.mjs";
import {
  POST_COGNITION_REVISIONS,
  createPostCognitionFixture,
} from "../../../test-support/non-destructive/post-cognition-fixture.mjs";
import {
  createPostCognitionEngine,
} from "../../../test-support/non-destructive/post-cognition-runner.mjs";

const execFileAsync = promisify(execFile);
const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
const absent = path => assert.rejects(access(path), error => error.code === "ENOENT");
const count = (values, expected) => values.filter(value => value === expected).length;

const expectedPostAuthOrder = [
  "codex-authenticate-device",
  "configure-interactive-codex",
  "install-git",
  "install-github-app-private-key",
  "install-github-app-configuration",
  "sync-github-helper-source",
  "install-github-app-helpers",
  "sync-codex-skills-repository",
  "install-codex-skills",
  "sync-mind-maintainer-source",
  "install-mind-maintainer",
  "render-post-cognition-review",
  "run-post-cognition-review",
  "verify-post-cognition-setup",
];

test("interactive Codex config edit preserves multiline values and profile overrides", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-boot-interactive-config-"));
  const home = join(root, "home", "my-user");
  const config = join(home, ".codex", "config.toml");
  const script = join(
    repositoryRoot,
    "examples",
    "post-cognition-agent",
    "scripts",
    "configure-interactive-codex.sh",
  );

  try {
    await mkdir(dirname(config), { recursive: true });
    await writeFile(config, [
      'personality = "pragmatic"',
      "matrix = [",
      "  [1, 2],",
      "  [3, 4],",
      "]",
      'approval_policy = "on-request"',
      'sandbox_mode = "workspace-write"',
      "",
      "[profiles.safe]",
      'approval_policy = "on-request"',
      'sandbox_mode = "read-only"',
      "",
    ].join("\n"));

    await execFileAsync("bash", [script], {
      env: { ...process.env, HOME: home },
    });

    assert.equal(await readFile(config, "utf8"), [
      'approval_policy = "never"',
      'sandbox_mode = "danger-full-access"',
      'personality = "pragmatic"',
      "matrix = [",
      "  [1, 2],",
      "  [3, 4],",
      "]",
      "",
      "[profiles.safe]",
      'approval_policy = "on-request"',
      'sandbox_mode = "read-only"',
      "",
    ].join("\n"));
    assert.equal((await stat(config)).mode & 0o777, 0o600);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("authored post-cognition recipe orders, resumes, and redacts setup", async () => {
  const fixture = await createPostCognitionFixture();
  const runtime = {
    executions: [],
    manualChecks: 0,
    skillsFailuresRemaining: 1,
  };
  const progress = [];
  const hosts = [];
  let terminalState;

  const createHost = boot => {
    const identityHost = new PostCognitionIdentityHost(
      `${String(boot).padStart(8, "0")}-1111-4111-8111-111111111111`,
    );
    const host = new PostCognitionCommandHost(fixture, identityHost, runtime);
    hosts.push(host);
    return { host, identityHost };
  };

  try {
    const scriptRoot = join(fixture.exampleRoot, "scripts");
    for (const scriptName of await readdir(scriptRoot)) {
      await execFileAsync("bash", ["-n", join(scriptRoot, scriptName)]);
    }

    assert.deepEqual(
      fixture.plan.steps.map(step => step.id).filter(id => expectedPostAuthOrder.includes(id)),
      expectedPostAuthOrder,
    );
    assert.ok(
      fixture.plan.steps.findIndex(step => step.id === "codex-authenticate-device") <
      fixture.plan.steps.findIndex(step => step.id === "configure-interactive-codex"),
    );

    const first = createHost(1);
    let interrupted = false;
    await assert.rejects(
      createPostCognitionEngine({
        commandHost: first.host,
        fixture,
        identityHost: first.identityHost,
        onProgress: event => {
          progress.push(event);
          if (!interrupted &&
              event.status === "step-failed" &&
              event.stepId === "install-codex-skills") {
            interrupted = true;
            throw new Error("simulated reboot after inspectable step failure");
          }
        },
      }).run(),
      /simulated reboot after inspectable step failure/u,
    );
    assert.equal(first.host.activeCount, 0);

    const failedCheckpoint = JSON.parse(await readFile(fixture.statePath, "utf8"));
    assert.deepEqual(failedCheckpoint.currentStep, {
      attempt: 1,
      id: "install-codex-skills",
      index: fixture.plan.steps.findIndex(step => step.id === "install-codex-skills"),
      phase: "failed",
    });
    assert.equal(failedCheckpoint.terminal, null);
    assert.ok(progress.some(event =>
      event.status === "step-failed" &&
      event.stepId === "install-codex-skills" &&
      event.diagnostic.recovery === "retry-step"));

    const completedBeforeResume = new Map([
      ["runner step configure-interactive-codex", 1],
      ["runner step install-git", 1],
      ["runner step sync-github-helper-source", 1],
      ["runner step install-github-app-helpers", 1],
      ["runner step sync-codex-skills-repository", 1],
    ]);
    for (const [label, expected] of completedBeforeResume) {
      assert.equal(count(runtime.executions, label), expected, label);
    }

    const resumed = createHost(2);
    const result = await createPostCognitionEngine({
      commandHost: resumed.host,
      fixture,
      identityHost: resumed.identityHost,
      onProgress: event => progress.push(event),
    }).run();
    terminalState = result.state;

    assert.equal(result.status, "succeeded");
    assert.equal(result.state.terminal?.status, "succeeded");
    assert.equal(resumed.host.activeCount, 0);
    for (const [label, expected] of completedBeforeResume) {
      assert.equal(count(runtime.executions, label), expected, `${label} replayed`);
    }
    assert.equal(count(runtime.executions, "runner step install-codex-skills"), 2);
    assert.equal(count(runtime.executions, "runner provider codex step run-post-cognition-review"), 1);
    assert.equal(count(runtime.executions, "runner step verify-post-cognition-setup"), 1);

    const succeededSteps = progress
      .filter(event => event.status === "step-succeeded")
      .map(event => event.stepId);
    let previous = -1;
    for (const id of expectedPostAuthOrder) {
      const index = succeededSteps.indexOf(id);
      assert.ok(index > previous, `${id} did not succeed in authored order`);
      previous = index;
    }
    assert.equal(progress.at(-1)?.status, "runner-succeeded");

    const privateKeyDestination = join(
      fixture.homeDirectory,
      ".config",
      "codex-github",
      "app.pem",
    );
    const appConfigurationDestination = join(
      fixture.homeDirectory,
      ".config",
      "codex-github",
      "codex.env",
    );
    assert.equal(await readFile(privateKeyDestination, "utf8"), `${fixture.values.certificate}\n`);
    assert.equal(
      await readFile(appConfigurationDestination, "utf8"),
      `${fixture.values.configuration}\n`,
    );
    assert.equal((await stat(privateKeyDestination)).mode & 0o777, 0o600);
    assert.equal((await stat(appConfigurationDestination)).mode & 0o777, 0o600);
    await absent(join(fixture.bootstrapSecretRoot, "github-app-private-key"));
    await absent(join(fixture.bootstrapSecretRoot, "github-app-configuration"));
    await absent(join(
      fixture.systemRoot,
      "run",
      "agent-boot",
      "prompts",
      "my-agent",
      "post-cognition-review.md",
    ));

    assert.deepEqual(
      hosts.flatMap(host => host.providerPrompts),
      [
        (await readFile(
          join(fixture.resourceRoot, "prompts", "review-post-cognition-setup"),
          "utf8",
        )).replace("{{agent-name}}", "My Agent"),
      ],
    );

    const terminalHost = createHost(3);
    const terminalResult = await createPostCognitionEngine({
      commandHost: terminalHost.host,
      fixture,
      identityHost: terminalHost.identityHost,
    }).run();
    assert.equal(terminalResult.status, "succeeded");
    assert.deepEqual(terminalHost.host.spawnCalls, []);
    assert.deepEqual(terminalHost.host.execCalls, []);

    const observable = JSON.stringify({
      assemblyFiles: fixture.assembly.files.map(file => ({
        contents: Buffer.from(file.contents).toString("utf8"),
        mode: file.mode,
        path: file.path,
      })),
      calls: hosts.flatMap(host => [...host.execCalls, ...host.spawnCalls]),
      plan: fixture.plan,
      progress,
      providerPrompts: hosts.flatMap(host => host.providerPrompts),
      state: terminalState,
    });
    for (const sensitive of Object.values(fixture.values)) {
      assert.doesNotMatch(observable, new RegExp(sensitive.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
    }
    assert.doesNotMatch(observable, /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u);
    assert.doesNotMatch(observable, /\bgh[pousr]_[A-Za-z0-9]{20,}\b/u);
    assert.doesNotMatch(observable, /\bsk-[A-Za-z0-9]{20,}\b/u);
    assert.doesNotMatch(observable, new RegExp(fixture.root, "u"));
    assert.deepEqual(POST_COGNITION_REVISIONS, {
      github: fixture.plan.steps.find(step => step.id === "sync-github-helper-source")
        .command.arguments[1],
      maintainer: fixture.plan.steps.find(step => step.id === "sync-mind-maintainer-source")
        .command.arguments[1],
      skills: fixture.plan.steps.find(step => step.id === "sync-codex-skills-repository")
        .command.arguments[1],
    });
  } finally {
    for (const host of hosts) host.cancelAll();
    assert.ok(hosts.every(host => host.activeCount === 0));
    await fixture.cleanup();
  }
});

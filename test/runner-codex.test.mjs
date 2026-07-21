import assert from "node:assert/strict";
import test from "node:test";

import {
  CodexBootstrapError,
  CodexBootstrapGate,
  runCodexBootstrapCommand,
} from "@agent-boot/runner/providers/codex";

const success = { exitCode: 0, reason: "exit", signal: null };
const failure = { exitCode: 1, reason: "exit", signal: null };
const execSuccess = stdout => ({ exitCode: 0, signal: null, stderr: "", stdout });

const descriptor = {
  command: {
    arguments: [
      "--profile", "agent-boot", "--strict-config", "exec", "--skip-git-repo-check", "-",
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
  environment: { HOME: "/home/my-user", PATH: "/opt/agent/bin:/usr/bin" },
  step: { id: "run-codex", kind: "provider", providerId: "codex", renderedPromptId: "prompt" },
  timeoutMs: 60_000,
};

class OrderedHost {
  events = [];
  execScripts = [];
  spawnScripts = [];

  exec(command) {
    this.events.push(`exec:${command.executable}:${(command.arguments ?? []).join(" ")}`);
    const script = this.execScripts.shift();
    if (script instanceof Error) return Promise.reject(script);
    assert.ok(script, "missing exec script");
    return Promise.resolve(script);
  }

  spawn(command) {
    this.events.push(`spawn:${command.executable}:${(command.arguments ?? []).join(" ")}`);
    const script = this.spawnScripts.shift();
    assert.ok(script, "missing spawn script");
    const result = script instanceof Error ? Promise.reject(script) : Promise.resolve(script);
    return {
      cancel: () => undefined,
      completion: result,
      pid: undefined,
      sendSignal: () => false,
    };
  }
}

class RecordingProfile {
  events;
  valid = true;

  constructor(events) {
    this.events = events;
  }

  ensure() {
    this.events.push("profile:ensure");
    return Promise.resolve();
  }

  verify() {
    this.events.push("profile:verify");
    return Promise.resolve(this.valid);
  }
}

const gateFor = (host, profile, authentication = { kind: "automatic-credentials" }) =>
  new CodexBootstrapGate({
    authentication,
    commandHost: host,
    manualPolicy: { completionCheckTimeoutMs: 1_000, maximumPollIntervalMs: 2_000 },
    profileStore: profile,
    version: "1.2.3",
  });

test("Codex readiness installs an exact source and verifies every gate in order", async () => {
  const host = new OrderedHost();
  host.execScripts.push(
    new Error("missing"),
    execSuccess("codex-cli 1.2.3\n"),
    execSuccess("Logged in using API key\n"),
  );
  host.spawnScripts.push(success);
  const profile = new RecordingProfile(host.events);

  await gateFor(host, profile).ensureReady(adapterInput);

  assert.deepEqual(host.events, [
    "exec:codex:--version",
    "spawn:npm:install --global @openai/codex@1.2.3",
    "exec:codex:--version",
    "profile:ensure",
    "profile:verify",
    "exec:codex:login status",
  ]);
});

test("private bootstrap command dispatches version and profile gates without shell text", async () => {
  const calls = [];
  const runtime = {
    profileStore: {
      ensure: async () => { calls.push("ensure"); },
      verify: async () => { calls.push("verify"); return true; },
    },
    readVersion: async () => { calls.push("version"); return "codex-cli 1.2.3\n"; },
  };

  await runCodexBootstrapCommand(["verify-version", "--expected", "1.2.3"], runtime);
  await runCodexBootstrapCommand(["configure-profile"], runtime);
  await runCodexBootstrapCommand(["verify-profile"], runtime);

  assert.deepEqual(calls, ["version", "ensure", "verify"]);
  await assert.rejects(
    runCodexBootstrapCommand(["verify-version", "--expected", "latest"], runtime),
    error => error instanceof CodexBootstrapError && error.stage === "installation",
  );
  await assert.rejects(
    runCodexBootstrapCommand(["future-operation"], runtime),
    error => error instanceof CodexBootstrapError && error.stage === "configuration",
  );
  const marker = "private-version-error";
  await assert.rejects(
    runCodexBootstrapCommand(
      ["verify-version", "--expected", "1.2.3"],
      { ...runtime, readVersion: async () => { throw new Error(marker); } },
    ),
    error =>
      error instanceof CodexBootstrapError &&
      error.stage === "installation" &&
      !error.message.includes(marker),
  );
});

test("automatic authentication fails closed without launching an interactive login", async () => {
  const marker = "private-auth-failure";
  const host = new OrderedHost();
  host.execScripts.push(
    execSuccess("codex-cli 1.2.3\n"),
    new Error(marker),
  );
  const profile = new RecordingProfile(host.events);

  await assert.rejects(
    gateFor(host, profile).ensureReady(adapterInput),
    error => error instanceof CodexBootstrapError && error.stage === "authentication",
  );
  assert.equal(host.spawnScripts.length, 0);
  assert.doesNotMatch(JSON.stringify(host.events), new RegExp(marker, "u"));
});

test("profile failures are reduced to a redacted configuration gate", async () => {
  const marker = "private-profile-failure";
  const host = new OrderedHost();
  host.execScripts.push(execSuccess("codex-cli 1.2.3\n"));
  const profile = {
    ensure: async () => { throw new Error(marker); },
    verify: async () => true,
  };

  await assert.rejects(
    gateFor(host, profile).ensureReady(adapterInput),
    error =>
      error instanceof CodexBootstrapError &&
      error.stage === "configuration" &&
      !error.message.includes(marker),
  );
});

test("manual authentication reuses the TTY contract and silent completion probes", async () => {
  const events = [];
  let canceled = false;
  let resolveForeground;
  const host = {
    exec: command => {
      events.push({ command, operation: "exec" });
      return Promise.resolve(execSuccess("codex-cli 1.2.3\n"));
    },
    spawn: command => {
      events.push({ command, operation: "spawn" });
      if (command.arguments.join(" ") === "login status") {
        const result = events.filter(event =>
          event.operation === "spawn" && event.command.arguments.join(" ") === "login status").length === 1
          ? failure
          : success;
        return {
          cancel: () => undefined,
          completion: Promise.resolve(result),
          pid: undefined,
          sendSignal: () => false,
        };
      }
      const completion = new Promise(resolve => { resolveForeground = resolve; });
      return {
        cancel: () => {
          canceled = true;
          resolveForeground({ exitCode: null, reason: "canceled", signal: "SIGTERM" });
        },
        completion,
        pid: 42,
        sendSignal: () => true,
      };
    },
  };
  const profile = new RecordingProfile(events);
  const gate = new CodexBootstrapGate({
    authentication: { kind: "manual-device-auth", pollIntervalSeconds: 1 },
    commandHost: host,
    manualPolicy: { completionCheckTimeoutMs: 321, maximumPollIntervalMs: 2_000 },
    manualScheduler: { sleep: () => Promise.resolve() },
    profileStore: profile,
    version: "1.2.3",
  });

  await gate.ensureReady(adapterInput);

  const probes = events.filter(event =>
    event.operation === "spawn" && event.command.arguments.join(" ") === "login status");
  const foreground = events.find(event =>
    event.operation === "spawn" && event.command.arguments.join(" ") === "login --device-auth");
  assert.equal(probes.length, 2);
  assert.ok(probes.every(event =>
    event.command.stdio === "stream" && event.command.timeoutMs === 321));
  assert.equal(foreground.command.stdio, "inherit");
  assert.deepEqual(foreground.command.forwardSignals, ["SIGHUP", "SIGINT", "SIGTERM"]);
  assert.equal(canceled, true);
});

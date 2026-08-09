import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import test from "node:test";

import {
  PromptJobResultStore,
  PromptJobUnitStore,
  installPromptJobs,
  runOnce,
  timerNameFor,
  uninstallPromptJobs,
} from "@agent-boot/scheduled-prompt-jobs";

class FakeSystemd {
  calls = [];
  failNextRestart = false;
  invalidSchedules = new Set();
  states = new Map();
  verified = [];

  async validate(expression) {
    this.calls.push(["calendar", expression]);
    if (this.invalidSchedules.has(expression)) throw new Error("invalid calendar");
  }

  async verifyUnits(paths) {
    this.calls.push(["verify", paths.map(path => path.split("/").at(-1))]);
    this.verified = await Promise.all(paths.map(path => readFile(path, "utf8")));
  }

  async daemonReload() {
    this.calls.push(["daemon-reload"]);
  }

  async disableTimer(name) {
    this.calls.push(["disable", name]);
    this.states.set(name, {
      active: false,
      enabled: false,
      nextMonotonic: "infinity",
      nextRealtime: "n/a",
    });
  }

  async enableTimer(name) {
    this.calls.push(["enable", name]);
    this.states.set(name, {
      active: false,
      enabled: true,
      nextMonotonic: "infinity",
      nextRealtime: "n/a",
    });
  }

  async restartTimer(name) {
    this.calls.push(["restart", name]);
    if (this.failNextRestart) {
      this.failNextRestart = false;
      throw new Error("restart failed");
    }
    this.states.set(name, {
      active: true,
      enabled: true,
      nextMonotonic: "infinity",
      nextRealtime: "Mon 2026-08-10 03:00:00 UTC",
    });
  }

  async startService(name) {
    this.calls.push(["start", name]);
  }

  async timerState(name) {
    this.calls.push(["state", name]);
    return this.states.get(name) ?? {
      active: false,
      enabled: false,
      nextMonotonic: "infinity",
      nextRealtime: "n/a",
    };
  }
}

const job = overrides => ({
  effectPolicy: "read-only",
  id: "canary",
  logRetention: 10,
  model: "gpt-5.6-sol",
  onCalendar: "*-*-* 03:00:00",
  overlapGroup: "heavy-work",
  persistent: true,
  prompt: "canary.md",
  randomizedDelaySeconds: 600,
  reasoningEffort: "high",
  timeoutSeconds: 300,
  workingDirectory: "workspace",
  ...overrides,
});

const createFixture = async jobs => {
  const root = await mkdtemp(join(tmpdir(), "agent-boot-prompt-systemd-"));
  const home = join(root, "home", "my-user");
  await mkdir(join(home, "workspace"), { recursive: true });
  for (const entry of jobs) {
    await writeFile(join(home, entry.prompt), `Run ${entry.id} as a report-only canary.\n`, {
      mode: 0o600,
    });
  }
  const manifestPath = join(home, "jobs.json");
  await writeFile(manifestPath, JSON.stringify({ jobs, version: 1 }), { mode: 0o600 });
  const systemd = new FakeSystemd();
  const runtime = {
    account: {
      gid: process.getgid(),
      group: "my-user",
      homeDirectory: home,
      uid: process.getuid(),
      username: "my-user",
    },
    manifestPath,
    systemd,
    unitStore: new PromptJobUnitStore(root),
  };
  return { home, manifestPath, root, runtime, systemd };
};

test("install publishes exact units, re-arms on every install, and uninstalls idempotently", async () => {
  const fixture = await createFixture([job()]);
  try {
    await installPromptJobs(fixture.runtime, true);
    await installPromptJobs(fixture.runtime, true);

    const service = await readFile(join(
      fixture.root,
      "etc/systemd/system/agent-boot-prompt-job-canary.service",
    ), "utf8");
    const timer = await readFile(join(
      fixture.root,
      "etc/systemd/system/agent-boot-prompt-job-canary.timer",
    ), "utf8");
    assert.match(service, /^User=my-user$/mu);
    assert.match(service, /^StandardInput=null$/mu);
    assert.match(service, /^KillMode=control-group$/mu);
    assert.match(service, /agent-boot-prompt-jobs run --account my-user/u);
    assert.match(timer, /^OnCalendar=\*-\*-\* 03:00:00$/mu);
    assert.match(timer, /^Persistent=true$/mu);
    assert.equal(fixture.systemd.verified.length, 2);
    assert.equal(
      fixture.systemd.calls.filter(([operation]) => operation === "restart").length,
      2,
    );
    assert.equal(
      fixture.systemd.calls.filter(([operation]) => operation === "state").length,
      2,
    );

    await uninstallPromptJobs(fixture.runtime);
    await uninstallPromptJobs(fixture.runtime);
    await assert.rejects(readFile(join(
      fixture.root,
      "etc/systemd/system/agent-boot-prompt-job-canary.timer",
    )), error => error.code === "ENOENT");
  } finally {
    await rm(fixture.root, { force: true, recursive: true });
  }
});

test("a failed repeat-install timer transition rolls back the prior exact units", async () => {
  const fixture = await createFixture([job()]);
  try {
    await installPromptJobs(fixture.runtime, true);
    const timerPath = join(
      fixture.root,
      "etc/systemd/system/agent-boot-prompt-job-canary.timer",
    );
    const original = await readFile(timerPath, "utf8");
    await writeFile(fixture.manifestPath, JSON.stringify({
      jobs: [job({ onCalendar: "*-*-* 04:00:00" })],
      version: 1,
    }), { mode: 0o600 });
    fixture.systemd.failNextRestart = true;

    await assert.rejects(installPromptJobs(fixture.runtime, true), /restart failed/u);
    assert.equal(await readFile(timerPath, "utf8"), original);
    const registry = JSON.parse(await readFile(join(
      fixture.root,
      "var/lib/agent-boot/prompt-jobs/my-user.json",
    ), "utf8"));
    assert.equal(registry.enabled, true);
  } finally {
    await rm(fixture.root, { force: true, recursive: true });
  }
});

test("unit publication restores earlier moves when a later target is unowned", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-boot-prompt-publication-"));
  try {
    const store = new PromptJobUnitStore(root);
    const service = "agent-boot-prompt-job-canary.service";
    const foreign = "agent-boot-prompt-job-foreign.timer";
    await store.publish(new Map([[service, "old service\n"]]), [], {
      afterPublish: async () => undefined,
    });
    await writeFile(store.unitPath(foreign), "foreign unit\n", { mode: 0o644 });

    await assert.rejects(store.publish(new Map([
      [service, "new service\n"],
      [foreign, "replacement\n"],
    ]), [service], {
      afterPublish: async () => undefined,
    }), /unsafe or unowned/u);
    assert.equal(await readFile(store.unitPath(service), "utf8"), "old service\n");
    assert.equal(await readFile(store.unitPath(foreign), "utf8"), "foreign unit\n");
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("a partially invalid manifest performs no unit verification or mutation", async () => {
  const fixture = await createFixture([
    job({ id: "first", prompt: "first.md" }),
    job({ id: "second", onCalendar: "bad schedule", prompt: "second.md" }),
  ]);
  try {
    fixture.systemd.invalidSchedules.add("bad schedule");
    await assert.rejects(installPromptJobs(fixture.runtime, true), /systemd rejected/u);
    assert.equal(fixture.systemd.calls.some(([operation]) => operation === "verify"), false);
    assert.equal(fixture.systemd.calls.some(([operation]) => [
      "daemon-reload", "disable", "enable", "restart",
    ].includes(operation)), false);
    await assert.rejects(readFile(join(
      fixture.root,
      "etc/systemd/system/agent-boot-prompt-job-first.service",
    )), error => error.code === "ENOENT");
  } finally {
    await rm(fixture.root, { force: true, recursive: true });
  }
});

test("enabled install rejects an active timer without a finite next trigger", async () => {
  const fixture = await createFixture([job()]);
  try {
    fixture.systemd.restartTimer = async name => {
      fixture.systemd.calls.push(["restart", name]);
      fixture.systemd.states.set(name, {
        active: true,
        enabled: true,
        nextMonotonic: "infinity",
        nextRealtime: "n/a",
      });
    };
    await assert.rejects(installPromptJobs(fixture.runtime, true), /finitely armed/u);
    await assert.rejects(readFile(join(
      fixture.root,
      "etc/systemd/system/agent-boot-prompt-job-canary.timer",
    )), error => error.code === "ENOENT");
    assert.equal(fixture.systemd.states.get(timerNameFor("canary")).active, false);
  } finally {
    await rm(fixture.root, { force: true, recursive: true });
  }
});

test("canary starts the exact service and requires read-only passing evidence", async () => {
  const fixture = await createFixture([job()]);
  try {
    await installPromptJobs(fixture.runtime, false);
    const resultStore = new PromptJobResultStore(join(
      fixture.home,
      ".local/state/agent-boot-prompt-jobs",
    ));
    await resultStore.record({
      finishedAt: new Date().toISOString(),
      jobId: "canary",
      result: "passed",
      version: 1,
    }, 10);
    assert.equal((await runOnce(fixture.runtime, "canary", true)).result, "passed");
    assert.deepEqual(
      fixture.systemd.calls.find(([operation]) => operation === "start"),
      ["start", "agent-boot-prompt-job-canary.service"],
    );

    await writeFile(fixture.manifestPath, JSON.stringify({
      jobs: [job({ effectPolicy: "reconcile-before-write" })],
      version: 1,
    }), { mode: 0o600 });
    await assert.rejects(runOnce(fixture.runtime, "canary", true), /must use the read-only/u);
  } finally {
    await rm(fixture.root, { force: true, recursive: true });
  }
});

import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import {
  PromptJobResultStore,
  runPromptJob,
} from "@agent-boot/scheduled-prompt-jobs";

const job = id => ({
  effectPolicy: "read-only",
  id,
  logRetention: 5,
  model: "gpt-5.6-sol",
  onCalendar: "*-*-* 03:00:00",
  overlapGroup: "heavy-work",
  persistent: false,
  prompt: `${id}.md`,
  randomizedDelaySeconds: 0,
  reasoningEffort: "high",
  timeoutSeconds: 30,
  workingDirectory: "workspace",
});

const fixture = async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-boot-prompt-locks-"));
  await mkdir(join(root, "workspace"));
  const jobs = [job("first"), job("second")];
  for (const entry of jobs) {
    await writeFile(join(root, entry.prompt), "Report local state only.\n", { mode: 0o600 });
  }
  const manifestPath = join(root, "jobs.json");
  await writeFile(manifestPath, JSON.stringify({ jobs, version: 1 }), { mode: 0o600 });
  const launcher = join(root, "fake-prompt-job");
  await writeFile(launcher, "#!/bin/sh\nsleep 0.25\nexit 0\n", { mode: 0o700 });
  await chmod(launcher, 0o700);
  const runtime = {
    account: {
      gid: process.getgid(),
      group: "my-user",
      homeDirectory: root,
      uid: process.getuid(),
      username: "my-user",
    },
    manifestPath,
    systemd: {
      validate: async () => undefined,
    },
  };
  return { launcher, root, runtime };
};

test("per-job and shared heavy-work locks skip overlapping executions", async () => {
  const { launcher, root, runtime } = await fixture();
  try {
    const first = runPromptJob(runtime, "first", { launcher });
    await delay(60);
    const duplicate = runPromptJob(runtime, "first", { launcher });
    assert.deepEqual(await Promise.all([first, duplicate]), [0, 0]);
    const store = new PromptJobResultStore(join(
      root,
      ".local",
      "state",
      "agent-boot-prompt-jobs",
    ));
    assert.equal((await store.read("first")).result, "skipped-overlap");

    await rm(join(root, ".local", "state", "agent-boot-prompt-jobs", "second"), {
      force: true,
      recursive: true,
    });
    const groupLeader = runPromptJob(runtime, "first", { launcher });
    await delay(60);
    const groupPeer = runPromptJob(runtime, "second", { launcher });
    assert.deepEqual(await Promise.all([groupLeader, groupPeer]), [0, 0]);
    assert.equal((await store.read("second")).result, "skipped-overlap");
    assert.match(
      await readFile(join(
        root,
        ".local/state/agent-boot-prompt-jobs/second/last-run.json",
      ), "utf8"),
      /"result":"skipped-overlap"/u,
    );
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

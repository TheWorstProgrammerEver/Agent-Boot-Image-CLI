import assert from "node:assert/strict";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import process from "node:process";
import test from "node:test";
import { URL } from "node:url";

import { NodeSpawnAdapter } from "@agent-boot/process";
import {
  PromptJobResultStore,
  executePromptJob,
} from "@agent-boot/scheduled-prompt-jobs";

import {
  processIsRunning,
  waitFor,
} from "../test-support/process-test-helpers.mjs";

const fixtureSource = new URL("../test-support/fake-scheduled-codex.mjs", import.meta.url);

const job = (root, overrides = {}) => ({
  effectPolicy: "read-only",
  id: "canary",
  logRetention: 2,
  model: "gpt-5.6-sol",
  onCalendar: "*-*-* 03:00:00",
  overlapGroup: "heavy-work",
  persistent: false,
  prompt: "canary.md",
  promptPath: join(root, "canary.md"),
  randomizedDelaySeconds: 0,
  reasoningEffort: "high",
  timeoutSeconds: 30,
  workingDirectory: "workspace",
  workingDirectoryPath: join(root, "workspace"),
  ...overrides,
});

const fixture = async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-boot-prompt-executor-"));
  await mkdir(join(root, "workspace"));
  await writeFile(join(root, "canary.md"), "Produce a local report only.\n", { mode: 0o600 });
  const executable = join(root, "fake-codex");
  await copyFile(fixtureSource, executable);
  await chmod(executable, 0o755);
  return { executable, root };
};

test("fake Codex receives the policy and prompt followed by EOF in a minimal environment", async () => {
  const { executable, root } = await fixture();
  try {
    const resultStore = new PromptJobResultStore(join(root, "state"));
    const context = {
      codexExecutable: executable,
      homeDirectory: root,
      path: `${dirname(process.execPath)}:/usr/bin:/bin`,
      resultStore,
      spawnHost: new NodeSpawnAdapter({ terminationGraceMs: 50 }),
      username: "my-user",
    };
    for (let attempt = 0; attempt < 3; attempt += 1) {
      assert.equal((await executePromptJob(job(root), context)).result, "passed");
    }

    const evidence = JSON.parse(
      await readFile(join(root, "workspace", "fake-codex-evidence.json"), "utf8"),
    );
    assert.equal(evidence.cwd, join(root, "workspace"));
    assert.equal(evidence.stdinEnded, true);
    assert.match(evidence.input, /report-only job/u);
    assert.match(evidence.input, /Produce a local report only/u);
    assert.deepEqual(Object.keys(evidence.environment), [
      "CODEX_HOME",
      "GIT_TERMINAL_PROMPT",
      "HOME",
      "LANG",
      "LOGNAME",
      "PATH",
      "SHELL",
      "USER",
    ]);
    assert.equal(evidence.environment.HOME, root);
    assert.equal(evidence.arguments.at(-1), "-");

    const log = (await readFile(join(root, "state", "canary", "runs.jsonl"), "utf8"))
      .trim().split("\n");
    assert.equal(log.length, 2);
    const lastRun = await readFile(join(root, "state", "canary", "last-run.json"), "utf8");
    assert.doesNotMatch(lastRun, /Produce a local report|arbitrary private/u);
    assert.equal(JSON.parse(lastRun).result, "passed");

    await writeFile(join(root, "state", "canary", "last-run.json"), JSON.stringify({
      body: "arbitrary private response",
      finishedAt: new Date().toISOString(),
      jobId: "canary",
      result: "passed",
      version: 1,
    }), { mode: 0o600 });
    await assert.rejects(resultStore.read("canary"), /result state is invalid/u);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("timeout terminates the complete fake-Codex descendant process group", async () => {
  const { executable, root } = await fixture();
  try {
    await writeFile(join(root, "canary.md"), "FAKE_TIMEOUT_DESCENDANT\n", { mode: 0o600 });
    const result = await executePromptJob(job(root, { timeoutSeconds: 0.08 }), {
      codexExecutable: executable,
      homeDirectory: root,
      path: `${dirname(process.execPath)}:/usr/bin:/bin`,
      resultStore: new PromptJobResultStore(join(root, "state")),
      spawnHost: new NodeSpawnAdapter({ terminationGraceMs: 50 }),
      username: "my-user",
    });

    assert.equal(result.result, "timed-out");
    const descendant = Number(
      (await readFile(join(root, "workspace", "descendant.pid"), "utf8")).trim(),
    );
    await waitFor(() => !processIsRunning(descendant));
    assert.equal(processIsRunning(descendant), false);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

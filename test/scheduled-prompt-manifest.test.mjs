import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import test from "node:test";
import { fileURLToPath, URL } from "node:url";

import { NodeSpawnAdapter } from "@agent-boot/process";

import {
  CommandSystemdControl,
  PromptJobValidationError,
  loadScheduledPromptManifest,
  parseScheduledPromptManifest,
} from "@agent-boot/scheduled-prompt-jobs";

const validJob = overrides => ({
  effectPolicy: "read-only",
  id: "health-report",
  logRetention: 12,
  model: "gpt-5.6-sol",
  onCalendar: "*-*-* 03:00:00",
  overlapGroup: "heavy-work",
  persistent: true,
  prompt: "health-report.md",
  randomizedDelaySeconds: 900,
  reasoningEffort: "high",
  timeoutSeconds: 900,
  workingDirectory: "workspace",
  ...overrides,
});

const validManifest = jobs => ({ version: 1, jobs: jobs ?? [validJob()] });

test("versioned scheduled prompt manifests reject malformed execution policy", () => {
  const rejected = [
    [validManifest([validJob({ id: "bad/id" })]), /identifier/u],
    [validManifest([validJob({ prompt: "../escape.md" })]), /relative path/u],
    [validManifest([validJob({ workingDirectory: "../escape" })]), /relative path/u],
    [validManifest([validJob({ model: "future-model" })]), /Expected one of/u],
    [validManifest([validJob({ reasoningEffort: "extreme" })]), /Expected one of/u],
    [validManifest([validJob({ effectPolicy: "reconcile-before-write" })]), /Expected one of/u],
    [validManifest([validJob({ onCalendar: "daily\nInjected=true" })]), /calendar/u],
    [validManifest([validJob({ logRetention: 0 })]), /between 1 and 100/u],
    [validManifest([validJob(), validJob()]), /Duplicate job/u],
    [{ version: 2, jobs: [validJob()] }, /Expected 1/u],
  ];
  for (const [input, message] of rejected) {
    assert.throws(() => parseScheduledPromptManifest(input), error => {
      assert.ok(error instanceof PromptJobValidationError);
      assert.match(error.message, message);
      return true;
    });
  }
});

test("semantic loading validates every schedule, prompt, and working path", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-boot-prompt-manifest-"));
  try {
    await mkdir(join(root, "workspace"));
    await writeFile(join(root, "first.md"), "Inspect local state only.\n", { mode: 0o600 });
    await writeFile(join(root, "second.md"), "Inspect another local state.\n", { mode: 0o600 });
    const manifestPath = join(root, "jobs.json");
    await writeFile(manifestPath, JSON.stringify(validManifest([
      validJob({ id: "first", prompt: "first.md" }),
      validJob({ id: "second", onCalendar: "invalid schedule", prompt: "second.md" }),
    ])), { mode: 0o600 });
    const validated = [];

    await assert.rejects(loadScheduledPromptManifest({
      accountUid: process.getuid(),
      calendarValidator: {
        validate: async expression => {
          validated.push(expression);
          if (expression === "invalid schedule") throw new Error("invalid");
        },
      },
      homeDirectory: root,
      manifestPath,
    }), error => {
      assert.ok(error instanceof PromptJobValidationError);
      assert.equal(error.path, "$.jobs[1].onCalendar");
      return true;
    });
    assert.deepEqual(validated, ["*-*-* 03:00:00", "invalid schedule"]);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("semantic loading rejects missing, escaping, linked, and writable prompt inputs", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-boot-prompt-paths-"));
  const outside = await mkdtemp(join(tmpdir(), "agent-boot-prompt-outside-"));
  try {
    await mkdir(join(root, "workspace"));
    await writeFile(join(outside, "outside.md"), "outside\n", { mode: 0o600 });
    const manifestPath = join(root, "jobs.json");
    const loadPrompt = async prompt => {
      await writeFile(manifestPath, JSON.stringify(validManifest([validJob({ prompt })])), {
        mode: 0o600,
      });
      return loadScheduledPromptManifest({
        accountUid: process.getuid(),
        calendarValidator: { validate: async () => undefined },
        homeDirectory: root,
        manifestPath,
      });
    };

    await assert.rejects(loadPrompt("missing.md"), /missing or unreadable/u);
    await writeFile(join(root, "writable.md"), "writable\n", { mode: 0o600 });
    await chmod(join(root, "writable.md"), 0o622);
    await assert.rejects(loadPrompt("writable.md"), /private regular file/u);
    await import("node:fs/promises").then(({ symlink }) =>
      symlink(join(outside, "outside.md"), join(root, "linked.md")));
    await assert.rejects(loadPrompt("linked.md"), /symbolic link/u);
  } finally {
    await rm(root, { force: true, recursive: true });
    await rm(outside, { force: true, recursive: true });
  }
});

test("the public manifest and prompts pass the production schema and calendar path", async t => {
  if (spawnSync("/usr/bin/systemd-analyze", ["--version"], { stdio: "ignore" }).status !== 0) {
    t.skip("systemd-analyze is unavailable");
    return;
  }
  const root = await mkdtemp(join(tmpdir(), "agent-boot-prompt-example-"));
  const source = fileURLToPath(new URL("../examples/scheduled-prompt-jobs", import.meta.url));
  try {
    await mkdir(join(root, "workspace"));
    await copyFile(join(source, "jobs.json"), join(root, "jobs.json"));
    await copyFile(join(source, "prompts", "canary.md"), join(root, "canary.md"));
    await copyFile(
      join(source, "prompts", "maintenance-report.md"),
      join(root, "maintenance-report.md"),
    );
    for (const name of ["jobs.json", "canary.md", "maintenance-report.md"]) {
      await chmod(join(root, name), 0o600);
    }
    const loaded = await loadScheduledPromptManifest({
      accountUid: process.getuid(),
      calendarValidator: new CommandSystemdControl(new NodeSpawnAdapter()),
      homeDirectory: root,
      manifestPath: join(root, "jobs.json"),
    });
    assert.deepEqual(loaded.jobs.map(entry => entry.id), ["canary", "maintenance-report"]);

    const invalid = JSON.parse(await readFile(join(source, "jobs.json"), "utf8"));
    delete invalid.jobs[0].timeoutSeconds;
    assert.throws(() => parseScheduledPromptManifest(invalid), /timeoutSeconds.*Required/u);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

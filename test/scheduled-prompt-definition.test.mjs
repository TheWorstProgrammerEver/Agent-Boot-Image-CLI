import assert from "node:assert/strict";
import test from "node:test";

import {
  defineAgent,
  scheduledPromptJobs,
} from "@agent-boot/definition";

import { validDefinitionInput } from "../test-support/definition-fixtures.mjs";

test("definition recipe keeps role prompts local and installs the reusable target command", () => {
  const slice = scheduledPromptJobs({
    accountUsername: "my-user",
    installMode: "disabled",
    manifestSource: "./scheduled-prompts/jobs.json",
    prompts: [{
      assetId: "scheduled-canary-prompt",
      path: "canary.md",
      source: "./scheduled-prompts/canary.md",
    }],
  });
  const input = validDefinitionInput();
  input.assets.push(...slice.assets);
  input.steps.push(...slice.installSteps);
  const definition = defineAgent(input);
  const manifest = definition.assets.find(asset => asset.id === "scheduled-prompt-jobs-manifest");
  const prompt = definition.assets.find(asset => asset.id === "scheduled-canary-prompt");
  const install = definition.steps.find(step => step.id === "scheduled-prompt-jobs-install");

  assert.deepEqual(manifest.placement, {
    path: "scheduled-prompts/jobs.json",
    scope: "user-home",
  });
  assert.deepEqual(prompt.placement, {
    path: "scheduled-prompts/canary.md",
    scope: "user-home",
  });
  assert.equal(install.kind, "automatic");
  assert.deepEqual(install.command, {
    arguments: [
      "-n",
      "/usr/local/sbin/agent-boot-prompt-jobs",
      "install",
      "--account",
      "my-user",
      "--manifest",
      "scheduled-prompts/jobs.json",
      "--disabled",
    ],
    executable: "sudo",
    workingDirectory: { path: "workspace", scope: "user-home" },
  });
});

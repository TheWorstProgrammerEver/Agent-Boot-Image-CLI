import assert from "node:assert/strict";
import test from "node:test";

import {
  DefinitionValidationError,
  agentDefinitionSchema,
} from "../packages/definition/dist/index.js";
import { clone, validDefinitionInput } from "../test-support/definition-fixtures.mjs";

const rejects = (mutate, pattern) => {
  const input = clone(validDefinitionInput());
  mutate(input);
  assert.throws(
    () => agentDefinitionSchema.parse(input),
    (error) => error instanceof DefinitionValidationError && pattern.test(error.message),
  );
};

test("identity, Unix username, and definition URL fail independently", () => {
  rejects((input) => { input.agent.id = "My Agent"; }, /agent\.id.*lowercase identifier/u);
  rejects((input) => { input.agent.displayName = ""; }, /agent\.displayName.*1-128/u);
  rejects((input) => { input.account.username = "Root User"; }, /username.*Unix username/u);
  rejects((input) => { input.definitionUrl = "./my-agent.ts"; }, /absolute file URL/u);
  rejects(
    (input) => { input.definitionUrl = "file://remote-host/my-agent.ts"; },
    /absolute file URL/u,
  );
  rejects(
    (input) => { input.definitionUrl = "file:///workspace/definitions/my-agent%00.ts"; },
    /absolute file URL/u,
  );
  rejects((input) => { input.schemaVersion = 2; }, /schemaVersion.*Expected 1/u);
  rejects((input) => { input.futureField = true; }, /futureField.*Unknown field/u);
});

test("curated OS compatibility fields fail independently", () => {
  rejects(
    (input) => { input.operatingSystem.catalogId = "Raspberry Pi OS"; },
    /catalogId.*lowercase identifier/u,
  );
  rejects(
    (input) => { input.operatingSystem.compatibility.architecture = "ARM 64"; },
    /architecture.*lowercase identifier/u,
  );
  rejects(
    (input) => { input.operatingSystem.compatibility.boards = []; },
    /boards.*1-64 items/u,
  );
  rejects(
    (input) => {
      input.operatingSystem.compatibility.boards = Array.from(
        { length: 65 },
        (_, index) => `board-${String(index)}`,
      );
    },
    /boards.*1-64 items/u,
  );
});

test("network hostname and SSID fields fail independently", () => {
  rejects(
    (input) => { input.network.hostname = "My_Agent"; },
    /hostname.*lowercase hostname label/u,
  );
  rejects(
    (input) => { input.network.wifi.ssid = ""; },
    /ssid.*1-32 characters/u,
  );
  rejects(
    (input) => { input.network.wifi.ssid = "x".repeat(33); },
    /ssid.*1-32 characters/u,
  );
});

test("local and target paths fail independently", () => {
  rejects(
    (input) => { input.assets[0].source = "/etc/agent.json"; },
    /relative local path/u,
  );
  rejects(
    (input) => { input.assets[0].source = "./assets/"; },
    /local file path/u,
  );
  rejects(
    (input) => { input.assets[0].source = "./assets/agent%00.json"; },
    /local file path.*NUL/u,
  );
  rejects(
    (input) => {
      input.assets[0].source = {
        kind: "local",
        url: "file:///workspace/definitions/assets/agent%00.json",
      };
    },
    /absolute file URL/u,
  );
  rejects(
    (input) => { input.assets[0].placement.scope = "workspace"; },
    /scope.*system, user-home/u,
  );
  rejects(
    (input) => { input.assets[0].placement.path = "../credential"; },
    /normalized relative path/u,
  );
  rejects(
    (input) => {
      input.steps.find((step) => step.kind === "install-user-secret").destination =
        "/home/my-user/key";
    },
    /normalized relative path/u,
  );
});

test("resource and provider identifiers fail independently", () => {
  rejects(
    (input) => { input.assets[0].id = "Agent Config"; },
    /assets\[0\]\.id.*lowercase identifier/u,
  );
  rejects(
    (input) => { input.prompts[0].id = "Install Profile"; },
    /prompts\[0\]\.id.*lowercase identifier/u,
  );
  rejects(
    (input) => { input.account.initialPassword.id = "Account Password"; },
    /initialPassword\.id.*lowercase identifier/u,
  );
  rejects(
    (input) => { input.steps[2].command.executable.id = "Setup Script"; },
    /executable\.id.*lowercase identifier/u,
  );
  rejects(
    (input) => { input.providers[0].id = "Codex Provider"; },
    /providers\[0\]\.id.*lowercase identifier/u,
  );
});

test("environment fields and each parameterized step reject invalid values", () => {
  rejects(
    (input) => { input.steps[0].key = "DATABASE_URL"; },
    /permitted public environment key/u,
  );
  rejects(
    (input) => { input.steps[1].value = "unexpected"; },
    /Unset steps omit value/u,
  );
  rejects(
    (input) => { input.steps[2].command.arguments = "--bad"; },
    /arguments.*array/u,
  );
  rejects(
    (input) => { input.steps[3].command.arguments = ["x".repeat(1025)]; },
    /command\.arguments\[0\].*0-1024 characters/u,
  );
  rejects(
    (input) => { input.steps[2].command.executable = ""; },
    /executable.*1-256/u,
  );
  rejects(
    (input) => { input.steps[3].pollIntervalSeconds = 0; },
    /pollIntervalSeconds.*between 1/u,
  );
  rejects(
    (input) => { input.steps[4].lifetime = "forever"; },
    /lifetime.*runner/u,
  );
  rejects(
    (input) => { input.steps[6].retention = "persistent"; },
    /retention.*ephemeral/u,
  );
  rejects(
    (input) => { input.providers[0].promptTransport = "file"; },
    /promptTransport.*stdin/u,
  );
  rejects(
    (input) => { input.providers[0].command.executable = ""; },
    /providers\[0\]\.command\.executable.*1-256/u,
  );
  rejects(
    (input) => { input.providers[0].command.arguments = [null]; },
    /providers\[0\]\.command\.arguments\[0\].*string/u,
  );
  rejects(
    (input) => { input.steps[3].completionCheck.executable = ""; },
    /completionCheck\.executable.*1-256/u,
  );
  rejects(
    (input) => {
      input.steps[3].completionCheck.workingDirectory = {
        scope: "workspace",
        path: "tmp",
      };
    },
    /completionCheck\.workingDirectory\.scope.*system, user-home/u,
  );
});

test("empty and oversized arrays fail at their independent limits", () => {
  rejects((input) => { input.steps = []; }, /steps.*1-10000 items/u);
  rejects(
    (input) => { input.assets = Array(10_001).fill(input.assets[0]); },
    /assets.*0-10000 items/u,
  );
  rejects(
    (input) => { input.steps[2].command.arguments = Array(257).fill(""); },
    /command\.arguments.*0-256 items/u,
  );
  rejects(
    (input) => {
      input.prompts[0].variables = Array.from(
        { length: 129 },
        (_, index) => `variable-${String(index)}`,
      );
    },
    /prompts\[0\]\.variables.*0-128 items/u,
  );
  rejects(
    (input) => { input.steps[6].variables = Array(129).fill(input.steps[6].variables[0]); },
    /steps\[6\]\.variables.*0-128 items/u,
  );
});

test("discriminated unions and cross-references fail closed", () => {
  rejects((input) => { input.steps[2].kind = "shell"; }, /steps\[2\]\.kind.*Expected one of/u);
  rejects(
    (input) => { input.steps[6].variables[0].source.kind = "literal"; },
    /source\.kind.*Expected one of/u,
  );
  rejects(
    (input) => { input.steps[6].templateId = "missing-prompt"; },
    /Unknown prompt/u,
  );
  rejects(
    (input) => { input.steps[7].providerId = "missing-provider"; },
    /Unknown provider/u,
  );
  rejects(
    (input) => { input.steps.reverse(); },
    /rendered by an earlier step/u,
  );
});

test("secret references stay structural and reject unknown material fields", () => {
  rejects(
    (input) => { input.account.initialPassword.contents = "not-a-real-secret"; },
    /contents.*Unknown field/u,
  );
  rejects(
    (input) => { input.network.wifi.passphrase = "not-a-real-secret"; },
    /passphrase.*object/u,
  );
  rejects(
    (input) => {
      input.steps[6].variables[1].source.secret.id = "app-key";
    },
    /Conflicting local sources for secret "app-key"/u,
  );
  rejects(
    (input) => { input.steps[5].secretId = "app-key"; },
    /steps\[5\].*exactly one of "secret" or "secretId"/u,
  );
  rejects(
    (input) => { input.steps[6].variables[1].source.secretId = "app-key"; },
    /source.*exactly one of "secret" or "secretId"/u,
  );
});

test("unknown fields fail closed at nested object boundaries", () => {
  rejects(
    (input) => { input.agent.description = "future"; },
    /agent\.description.*Unknown field/u,
  );
  rejects(
    (input) => { input.operatingSystem.compatibility.release = "future"; },
    /compatibility\.release.*Unknown field/u,
  );
  rejects(
    (input) => { input.network.wifi.hidden = true; },
    /wifi\.hidden.*Unknown field/u,
  );
  rejects(
    (input) => { input.assets[0].placement.mode = "0600"; },
    /placement\.mode.*Unknown field/u,
  );
  rejects(
    (input) => {
      input.assets[0].source = {
        kind: "local",
        url: "file:///workspace/definitions/assets/agent.json",
        digest: "future",
      };
    },
    /source\.digest.*Unknown field/u,
  );
  rejects(
    (input) => { input.providers[0].command.timeout = 30; },
    /providers\[0\]\.command\.timeout.*Unknown field/u,
  );
  rejects(
    (input) => { input.steps[6].variables[0].source.default = "future"; },
    /source\.default.*Unknown field/u,
  );
  rejects(
    (input) => { input.steps[7].timeout = 30; },
    /steps\[7\]\.timeout.*Unknown field/u,
  );
});

test("duplicate identities and prompt bindings fail independently", () => {
  rejects(
    (input) => { input.operatingSystem.compatibility.boards.push("raspberry-pi-5"); },
    /Duplicate identifier "raspberry-pi-5"/u,
  );
  rejects(
    (input) => { input.steps[1].id = input.steps[0].id; },
    /Duplicate identifier "set-agent-name"/u,
  );
  rejects(
    (input) => { input.providers.push(clone(input.providers[0])); },
    /Duplicate identifier "codex"/u,
  );
  rejects(
    (input) => { input.steps[6].variables.pop(); },
    /Prompt variable "callback-secret" is not bound/u,
  );
  rejects(
    (input) => {
      input.steps[6].variables.push({
        name: "undeclared",
        source: { kind: "environment", key: "AGENT_NAME" },
      });
    },
    /Prompt variable "undeclared" is not declared/u,
  );
});

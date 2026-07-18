import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFINITION_SCHEMA_VERSION,
  agentDefinitionSchema,
  defineAgent,
} from "../packages/definition/dist/index.js";
import { runnerPlanSchema } from "../packages/protocol/dist/index.js";
import { validDefinitionInput } from "../test-support/definition-fixtures.mjs";

test("builders create one canonical definition with every ordered step variant", () => {
  const definition = defineAgent(validDefinitionInput());

  assert.equal(definition.schemaVersion, DEFINITION_SCHEMA_VERSION);
  assert.deepEqual(
    definition.steps.map((step) => step.kind),
    [
      "environment",
      "environment",
      "automatic",
      "manual",
      "fire-and-forget",
      "install-user-secret",
      "prompt",
      "provider",
    ],
  );
  assert.deepEqual(
    definition.steps
      .filter((step) => step.kind === "environment")
      .map((step) => step.operation),
    ["set", "unset"],
  );
  assert.deepEqual(
    definition.steps.find((step) => step.kind === "prompt").variables.map(
      (variable) => variable.source.kind,
    ),
    ["environment", "secret"],
  );
});

test("local references normalize relative to the definition file without reading files", () => {
  const definition = defineAgent(validDefinitionInput());

  assert.equal(
    definition.assets[0].source.url,
    "file:///workspace/definitions/assets/agent.json",
  );
  assert.equal(
    definition.prompts[0].source.url,
    "file:///workspace/definitions/prompts/install-profile.md",
  );
  assert.equal(
    definition.scripts[0].source.url,
    "file:///workspace/definitions/scripts/setup.sh",
  );
  assert.ok(
    definition.secrets.every((entry) => entry.source.url.startsWith(
      "file:///workspace/definitions/secrets/",
    )),
  );
  assert.equal(definition.secrets.length, 4);
});

test("canonical definitions are JSON-safe and survive canonical validation", () => {
  const definition = defineAgent(validDefinitionInput());
  const serialized = JSON.stringify(definition);
  const roundTripped = JSON.parse(serialized);

  assert.deepEqual(roundTripped, definition);
  assert.deepEqual(agentDefinitionSchema.parse(roundTripped), definition);
  assert.doesNotMatch(serialized, /contents|materialized|not-a-real-secret/u);
});

test("accepted command arguments satisfy the canonical runner-plan boundary", () => {
  const input = validDefinitionInput();
  input.steps[3].command.arguments = ["x".repeat(1024)];
  const definition = defineAgent(input);
  const manualStep = definition.steps.find((step) => step.kind === "manual");

  assert.ok(manualStep);
  assert.doesNotThrow(() => runnerPlanSchema.parse({
    schemaVersion: 1,
    agentId: definition.agent.id,
    providers: [],
    steps: [manualStep],
  }));
});

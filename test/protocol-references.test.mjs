import assert from "node:assert/strict";
import test from "node:test";

import {
  ProtocolValidationError,
  assemblyDocumentsSchema,
  manifestSchema,
  runnerPlanSchema,
} from "../packages/protocol/dist/index.js";
import { clone, validAssemblyDocuments } from "../test-support/protocol-fixtures.mjs";

const rejects = (schema, value, pattern) => {
  assert.throws(
    () => schema.parse(value),
    (error) => error instanceof ProtocolValidationError && pattern.test(error.message),
  );
};

test("manifest runner installation references declared assets", () => {
  const { manifest } = validAssemblyDocuments();
  const unknownAsset = clone(manifest);
  unknownAsset.bootstrap.runnerInstallation.runtimeAssetId = "missing-runtime";
  rejects(manifestSchema, unknownAsset, /Unknown asset reference "missing-runtime"/);
});

test("runner plan references declared providers and earlier rendered prompts", () => {
  const { runnerPlan } = validAssemblyDocuments();
  const unknownProvider = clone(runnerPlan);
  unknownProvider.steps.at(-1).providerId = "missing-provider";
  rejects(runnerPlanSchema, unknownProvider, /Unknown provider "missing-provider"/);

  const promptAfterProvider = clone(runnerPlan);
  const prompt = promptAfterProvider.steps.splice(-2, 1)[0];
  promptAfterProvider.steps.push(prompt);
  rejects(runnerPlanSchema, promptAfterProvider, /must be produced by an earlier prompt step/);
});

test("aggregate assembly validation joins agent and prompt contracts", () => {
  const documents = validAssemblyDocuments();

  const wrongAgent = clone(documents);
  wrongAgent.runnerPlan.agentId = "different-agent";
  rejects(assemblyDocumentsSchema, wrongAgent, /Expected agentId "reviewer-agent"/);

  const missingTemplate = clone(documents);
  missingTemplate.runnerPlan.steps.find((step) => step.kind === "prompt").templateId =
    "missing-template";
  rejects(assemblyDocumentsSchema, missingTemplate, /Unknown prompt template "missing-template"/);

  const unboundVariable = clone(documents);
  unboundVariable.runnerPlan.steps.find((step) => step.kind === "prompt").variables.pop();
  rejects(assemblyDocumentsSchema, unboundVariable, /Prompt variable "callback-secret" is not bound/);

  const undeclaredVariable = clone(documents);
  undeclaredVariable.runnerPlan.steps.find((step) => step.kind === "prompt").variables.push({
    name: "extra-binding",
    source: { kind: "environment", key: "AGENT_NAME" },
  });
  rejects(assemblyDocumentsSchema, undeclaredVariable, /not declared by the template/);
});

test("duplicate identifiers fail before execution can become ambiguous", () => {
  const { manifest, runnerPlan } = validAssemblyDocuments();
  const duplicateAsset = clone(manifest);
  duplicateAsset.assets[1].id = duplicateAsset.assets[0].id;
  rejects(manifestSchema, duplicateAsset, /Duplicate identifier "node-runtime"/);

  const duplicateStep = clone(runnerPlan);
  duplicateStep.steps[1].id = duplicateStep.steps[0].id;
  rejects(runnerPlanSchema, duplicateStep, /Duplicate identifier "set-agent-name"/);
});

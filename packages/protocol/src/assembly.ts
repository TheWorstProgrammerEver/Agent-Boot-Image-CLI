import { manifestSchema, type AssemblyManifest } from "./manifest.js";
import { osLockSchema, type OsLock } from "./os-lock.js";
import { runnerPlanSchema, type RunnerPlan } from "./runner-plan.js";
import { createRuntimeSchema, fail, parseObject, required } from "./schema.js";

export interface AssemblyDocuments {
  manifest: AssemblyManifest;
  runnerPlan: RunnerPlan;
  osLock: OsLock;
}

const validatePromptReferences = (
  manifest: AssemblyManifest,
  runnerPlan: RunnerPlan,
  path: string,
) => {
  const prompts = new Map(manifest.prompts.map((prompt) => [prompt.id, prompt]));
  for (const [index, step] of runnerPlan.steps.entries()) {
    if (step.kind !== "prompt") continue;
    const prompt = prompts.get(step.templateId);
    if (prompt === undefined) {
      fail(
        `${path}.runnerPlan.steps[${String(index)}].templateId`,
        `Unknown prompt template ${JSON.stringify(step.templateId)}.`,
      );
    }
    const declaredVariables = new Set(prompt.variables);
    const boundVariables = new Set(step.variables.map((variable) => variable.name));
    for (const variable of declaredVariables) {
      if (!boundVariables.has(variable)) {
        fail(
          `${path}.runnerPlan.steps[${String(index)}].variables`,
          `Prompt variable ${JSON.stringify(variable)} is not bound.`,
        );
      }
    }
    for (const variable of boundVariables) {
      if (!declaredVariables.has(variable)) {
        fail(
          `${path}.runnerPlan.steps[${String(index)}].variables`,
          `Prompt variable ${JSON.stringify(variable)} is not declared by the template.`,
        );
      }
    }
  }
};

const parseAssemblyDocuments = (input: unknown, path: string): AssemblyDocuments => {
  const value = parseObject(input, path, ["manifest", "runnerPlan", "osLock"]);
  const manifest = manifestSchema.parse(required(value, "manifest", path));
  const runnerPlan = runnerPlanSchema.parse(required(value, "runnerPlan", path));
  const osLock = osLockSchema.parse(required(value, "osLock", path));
  if (manifest.agent.id !== runnerPlan.agentId) {
    fail(
      `${path}.runnerPlan.agentId`,
      `Expected agentId ${JSON.stringify(manifest.agent.id)} from manifest.json.`,
    );
  }
  validatePromptReferences(manifest, runnerPlan, path);
  return { manifest, runnerPlan, osLock };
};

export const assemblyDocumentsSchema = createRuntimeSchema(
  "Agent Boot assembly documents",
  parseAssemblyDocuments,
);

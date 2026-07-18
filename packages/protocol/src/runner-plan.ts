import {
  parseCommandDescriptor,
  parseIdentifier,
  SCHEMA_VERSION,
  type CommandDescriptor,
  type SchemaVersion,
} from "./common.js";
import {
  assertUnique,
  createRuntimeSchema,
  fail,
  parseArray,
  parseLiteral,
  parseObject,
  required,
  type Parser,
} from "./schema.js";
import { parseRunnerStep, type RunnerStep } from "./steps.js";

export interface ProviderDescriptor {
  id: string;
  command: CommandDescriptor;
  promptTransport: "stdin";
}

export interface RunnerPlan {
  schemaVersion: SchemaVersion;
  agentId: string;
  providers: ProviderDescriptor[];
  steps: RunnerStep[];
}

const parseProvider: Parser<ProviderDescriptor> = (input, path) => {
  const value = parseObject(input, path, ["id", "command", "promptTransport"]);
  return {
    id: parseIdentifier(required(value, "id", path), `${path}.id`),
    command: parseCommandDescriptor(required(value, "command", path), `${path}.command`),
    promptTransport: parseLiteral(
      required(value, "promptTransport", path),
      `${path}.promptTransport`,
      "stdin",
    ),
  };
};

const validateStepReferences = (
  providers: readonly ProviderDescriptor[],
  steps: readonly RunnerStep[],
  path: string,
) => {
  const providerIds = new Set(providers.map((provider) => provider.id));
  const renderedPromptIds = new Set<string>();
  for (const [index, step] of steps.entries()) {
    const stepPath = `${path}.steps[${String(index)}]`;
    if (step.kind === "prompt") {
      if (renderedPromptIds.has(step.renderedPromptId)) {
        fail(stepPath, `Duplicate rendered prompt ${JSON.stringify(step.renderedPromptId)}.`);
      }
      renderedPromptIds.add(step.renderedPromptId);
    }
    if (step.kind === "provider") {
      if (!providerIds.has(step.providerId)) {
        fail(`${stepPath}.providerId`, `Unknown provider ${JSON.stringify(step.providerId)}.`);
      }
      if (!renderedPromptIds.has(step.renderedPromptId)) {
        fail(
          `${stepPath}.renderedPromptId`,
          `Rendered prompt ${JSON.stringify(step.renderedPromptId)} must be produced by an earlier prompt step.`,
        );
      }
    }
  }
};

const parseRunnerPlan = (input: unknown, path: string): RunnerPlan => {
  const value = parseObject(input, path, ["schemaVersion", "agentId", "providers", "steps"]);
  const providers = parseArray(
    required(value, "providers", path),
    `${path}.providers`,
    parseProvider,
  );
  const steps = parseArray(required(value, "steps", path), `${path}.steps`, parseRunnerStep);
  assertUnique(providers, `${path}.providers`, (provider) => provider.id);
  assertUnique(steps, `${path}.steps`, (step) => step.id);
  validateStepReferences(providers, steps, path);
  return {
    schemaVersion: parseLiteral(
      required(value, "schemaVersion", path),
      `${path}.schemaVersion`,
      SCHEMA_VERSION,
    ),
    agentId: parseIdentifier(required(value, "agentId", path), `${path}.agentId`),
    providers,
    steps,
  };
};

export const runnerPlanSchema = createRuntimeSchema("runner-plan.json", parseRunnerPlan);

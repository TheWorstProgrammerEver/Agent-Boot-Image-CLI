import { parseCommand } from "./command.js";
import {
  parsePromptVariableSource,
  parseExclusiveSecretReference,
  type ResourceRegistry,
} from "./resources.js";
import type { PromptVariableBinding, SequenceStep } from "./steps.js";
import {
  assertUnique,
  fail,
  parseArray,
  parseEnvironmentKey,
  parseIdentifier,
  parseObject,
  parsePositiveInteger,
  parseRelativePath,
  parseString,
  required,
} from "./validation.js";

const parseBase = (value: Record<string, unknown>, path: string) => ({
  id: parseIdentifier(required(value, "id", path), `${path}.id`),
});

const parsePromptBinding = (
  input: unknown,
  registry: ResourceRegistry,
  path: string,
): PromptVariableBinding => {
  const value = parseObject(input, path, ["name", "source"]);
  return {
    name: parseIdentifier(required(value, "name", path), `${path}.name`),
    source: parsePromptVariableSource(
      required(value, "source", path),
      registry,
      `${path}.source`,
    ),
  };
};

export const parseStep = (
  input: unknown,
  registry: ResourceRegistry,
  path: string,
): SequenceStep => {
  const discriminator = parseObject(input, path, [
    "id", "kind", "operation", "key", "value", "command", "completionCheck",
    "pollIntervalSeconds", "lifetime", "templateId", "renderedPromptId", "retention",
    "variables", "providerId", "secret", "secretId", "destination",
  ]);
  const kind = required(discriminator, "kind", path);
  const base = parseBase(discriminator, path);
  if (kind === "environment") {
    const value = parseObject(input, path, ["id", "kind", "operation", "key", "value"]);
    const operation = required(value, "operation", path);
    const key = parseEnvironmentKey(required(value, "key", path), `${path}.key`);
    if (operation === "set") {
      return {
        ...base,
        kind,
        operation,
        key,
        value: parseString(required(value, "value", path), `${path}.value`, {
          minLength: 0,
          maxLength: 4096,
        }),
      };
    }
    if (operation === "unset") {
      if (Object.hasOwn(value, "value")) fail(`${path}.value`, "Unset steps omit value.");
      return { ...base, kind, operation, key };
    }
    fail(`${path}.operation`, "Expected one of: set, unset.");
  }
  if (kind === "automatic") {
    const value = parseObject(input, path, ["id", "kind", "command"]);
    return {
      ...base,
      kind,
      command: parseCommand(required(value, "command", path), registry, `${path}.command`),
    };
  }
  if (kind === "manual") {
    const value = parseObject(input, path, [
      "id", "kind", "command", "completionCheck", "pollIntervalSeconds",
    ]);
    return {
      ...base,
      kind,
      command: parseCommand(required(value, "command", path), registry, `${path}.command`),
      completionCheck: parseCommand(
        required(value, "completionCheck", path),
        registry,
        `${path}.completionCheck`,
      ),
      pollIntervalSeconds: parsePositiveInteger(
        required(value, "pollIntervalSeconds", path),
        `${path}.pollIntervalSeconds`,
        86_400,
      ),
    };
  }
  if (kind === "fire-and-forget") {
    const value = parseObject(input, path, ["id", "kind", "command", "lifetime"]);
    if (required(value, "lifetime", path) !== "runner") {
      fail(`${path}.lifetime`, 'Expected "runner".');
    }
    return {
      ...base,
      kind,
      command: parseCommand(required(value, "command", path), registry, `${path}.command`),
      lifetime: "runner",
    };
  }
  if (kind === "prompt") {
    const value = parseObject(input, path, [
      "id", "kind", "templateId", "renderedPromptId", "retention", "variables",
    ]);
    if (required(value, "retention", path) !== "ephemeral") {
      fail(`${path}.retention`, 'Expected "ephemeral".');
    }
    const variables = parseArray(
      required(value, "variables", path),
      `${path}.variables`,
      (binding, bindingPath) => parsePromptBinding(binding, registry, bindingPath),
      { maxLength: 128 },
    );
    assertUnique(variables, `${path}.variables`, (binding) => binding.name);
    return {
      ...base,
      kind,
      templateId: parseIdentifier(required(value, "templateId", path), `${path}.templateId`),
      renderedPromptId: parseIdentifier(
        required(value, "renderedPromptId", path),
        `${path}.renderedPromptId`,
      ),
      retention: "ephemeral",
      variables,
    };
  }
  if (kind === "provider") {
    const value = parseObject(input, path, ["id", "kind", "providerId", "renderedPromptId"]);
    return {
      ...base,
      kind,
      providerId: parseIdentifier(required(value, "providerId", path), `${path}.providerId`),
      renderedPromptId: parseIdentifier(
        required(value, "renderedPromptId", path),
        `${path}.renderedPromptId`,
      ),
    };
  }
  if (kind === "install-user-secret") {
    const value = parseObject(input, path, [
      "id", "kind", "secret", "secretId", "destination",
    ]);
    const reference = parseExclusiveSecretReference(value, registry, path);
    return {
      ...base,
      kind,
      secretId: reference.id,
      destination: parseRelativePath(
        required(value, "destination", path),
        `${path}.destination`,
      ),
    };
  }
  fail(
    `${path}.kind`,
    "Expected one of: environment, automatic, manual, fire-and-forget, prompt, provider, install-user-secret.",
  );
};

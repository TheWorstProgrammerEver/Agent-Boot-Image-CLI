import {
  parseCommandDescriptor,
  parseIdentifier,
  parsePublicEnvironmentKey,
  parseRelativePath,
  type CommandDescriptor,
  type PublicEnvironmentKey,
} from "./common.js";
import {
  assertUnique,
  fail,
  parseArray,
  parseEnum,
  parseInteger,
  parseLiteral,
  parseObject,
  parseString,
  required,
  type Parser,
} from "./schema.js";

interface StepBase {
  id: string;
}

export type EnvironmentStep =
  | (StepBase & {
      kind: "environment";
      operation: "set";
      key: PublicEnvironmentKey;
      value: string;
    })
  | (StepBase & {
      kind: "environment";
      operation: "unset";
      key: PublicEnvironmentKey;
    });

export interface AutomaticStep extends StepBase {
  kind: "automatic";
  command: CommandDescriptor;
}

export interface ManualStep extends StepBase {
  kind: "manual";
  command: CommandDescriptor;
  completionCheck: CommandDescriptor;
  pollIntervalSeconds: number;
}

export interface FireAndForgetStep extends StepBase {
  kind: "fire-and-forget";
  command: CommandDescriptor;
  lifetime: "runner";
}

export type PromptVariableSource =
  | { kind: "environment"; key: PublicEnvironmentKey }
  | { kind: "secret"; secretId: string };

export interface PromptVariableBinding {
  name: string;
  source: PromptVariableSource;
}

export interface PromptStep extends StepBase {
  kind: "prompt";
  templateId: string;
  renderedPromptId: string;
  retention: "ephemeral";
  variables: PromptVariableBinding[];
}

export interface ProviderStep extends StepBase {
  kind: "provider";
  providerId: string;
  renderedPromptId: string;
}

export interface InstallUserSecretStep extends StepBase {
  kind: "install-user-secret";
  secretId: string;
  destination: string;
}

export type RunnerStep =
  | EnvironmentStep
  | AutomaticStep
  | ManualStep
  | FireAndForgetStep
  | PromptStep
  | ProviderStep
  | InstallUserSecretStep;

const parseStepBase = (value: Record<string, unknown>, path: string) => ({
  id: parseIdentifier(required(value, "id", path), `${path}.id`),
});

const parseEnvironmentStep: Parser<EnvironmentStep> = (input, path) => {
  const discriminator = parseObject(input, path, ["id", "kind", "operation", "key", "value"]);
  const operation = parseEnum(
    required(discriminator, "operation", path),
    `${path}.operation`,
    ["set", "unset"],
  );
  const base = parseStepBase(discriminator, path);
  const kind = parseLiteral(required(discriminator, "kind", path), `${path}.kind`, "environment");
  const key = parsePublicEnvironmentKey(
    required(discriminator, "key", path),
    `${path}.key`,
  );
  if (operation === "set") {
    return {
      ...base,
      kind,
      operation,
      key,
      value: parseString(required(discriminator, "value", path), `${path}.value`, {
        minLength: 0,
        maxLength: 4096,
      }),
    };
  }
  if (Object.hasOwn(discriminator, "value")) {
    fail(`${path}.value`, "Unset environment steps must not include a value.");
  }
  return { ...base, kind, operation, key };
};

const parseAutomaticStep: Parser<AutomaticStep> = (input, path) => {
  const value = parseObject(input, path, ["id", "kind", "command"]);
  return {
    ...parseStepBase(value, path),
    kind: parseLiteral(required(value, "kind", path), `${path}.kind`, "automatic"),
    command: parseCommandDescriptor(required(value, "command", path), `${path}.command`),
  };
};

const parseManualStep: Parser<ManualStep> = (input, path) => {
  const value = parseObject(input, path, [
    "id",
    "kind",
    "command",
    "completionCheck",
    "pollIntervalSeconds",
  ]);
  return {
    ...parseStepBase(value, path),
    kind: parseLiteral(required(value, "kind", path), `${path}.kind`, "manual"),
    command: parseCommandDescriptor(required(value, "command", path), `${path}.command`),
    completionCheck: parseCommandDescriptor(
      required(value, "completionCheck", path),
      `${path}.completionCheck`,
    ),
    pollIntervalSeconds: parseInteger(
      required(value, "pollIntervalSeconds", path),
      `${path}.pollIntervalSeconds`,
      { minimum: 1, maximum: 86_400 },
    ),
  };
};

const parseFireAndForgetStep: Parser<FireAndForgetStep> = (input, path) => {
  const value = parseObject(input, path, ["id", "kind", "command", "lifetime"]);
  return {
    ...parseStepBase(value, path),
    kind: parseLiteral(required(value, "kind", path), `${path}.kind`, "fire-and-forget"),
    command: parseCommandDescriptor(required(value, "command", path), `${path}.command`),
    lifetime: parseLiteral(required(value, "lifetime", path), `${path}.lifetime`, "runner"),
  };
};

const parsePromptVariableSource: Parser<PromptVariableSource> = (input, path) => {
  const discriminator = parseObject(input, path, ["kind", "key", "secretId"]);
  const kind = required(discriminator, "kind", path);
  if (kind === "environment") {
    const value = parseObject(input, path, ["kind", "key"]);
    return {
      kind: "environment",
      key: parsePublicEnvironmentKey(required(value, "key", path), `${path}.key`),
    };
  }
  if (kind === "secret") {
    const value = parseObject(input, path, ["kind", "secretId"]);
    return {
      kind: "secret",
      secretId: parseIdentifier(required(value, "secretId", path), `${path}.secretId`),
    };
  }
  fail(`${path}.kind`, "Expected one of: environment, secret.");
};

const parsePromptVariable: Parser<PromptVariableBinding> = (input, path) => {
  const value = parseObject(input, path, ["name", "source"]);
  return {
    name: parseIdentifier(required(value, "name", path), `${path}.name`),
    source: parsePromptVariableSource(required(value, "source", path), `${path}.source`),
  };
};

const parsePromptStep: Parser<PromptStep> = (input, path) => {
  const value = parseObject(input, path, [
    "id",
    "kind",
    "templateId",
    "renderedPromptId",
    "retention",
    "variables",
  ]);
  const variables = parseArray(
    required(value, "variables", path),
    `${path}.variables`,
    parsePromptVariable,
    { maxLength: 128 },
  );
  assertUnique(variables, `${path}.variables`, (variable) => variable.name);
  return {
    ...parseStepBase(value, path),
    kind: parseLiteral(required(value, "kind", path), `${path}.kind`, "prompt"),
    templateId: parseIdentifier(required(value, "templateId", path), `${path}.templateId`),
    renderedPromptId: parseIdentifier(
      required(value, "renderedPromptId", path),
      `${path}.renderedPromptId`,
    ),
    retention: parseLiteral(required(value, "retention", path), `${path}.retention`, "ephemeral"),
    variables,
  };
};

const parseProviderStep: Parser<ProviderStep> = (input, path) => {
  const value = parseObject(input, path, ["id", "kind", "providerId", "renderedPromptId"]);
  return {
    ...parseStepBase(value, path),
    kind: parseLiteral(required(value, "kind", path), `${path}.kind`, "provider"),
    providerId: parseIdentifier(required(value, "providerId", path), `${path}.providerId`),
    renderedPromptId: parseIdentifier(
      required(value, "renderedPromptId", path),
      `${path}.renderedPromptId`,
    ),
  };
};

const parseInstallUserSecretStep: Parser<InstallUserSecretStep> = (input, path) => {
  const value = parseObject(input, path, ["id", "kind", "secretId", "destination"]);
  return {
    ...parseStepBase(value, path),
    kind: parseLiteral(
      required(value, "kind", path),
      `${path}.kind`,
      "install-user-secret",
    ),
    secretId: parseIdentifier(required(value, "secretId", path), `${path}.secretId`),
    destination: parseRelativePath(
      required(value, "destination", path),
      `${path}.destination`,
    ),
  };
};

export const parseRunnerStep: Parser<RunnerStep> = (input, path) => {
  const discriminator = parseObject(input, path, [
    "id",
    "kind",
    "operation",
    "key",
    "value",
    "command",
    "completionCheck",
    "pollIntervalSeconds",
    "lifetime",
    "templateId",
    "renderedPromptId",
    "retention",
    "variables",
    "providerId",
    "secretId",
    "destination",
  ]);
  const kind = required(discriminator, "kind", path);
  switch (kind) {
    case "environment":
      return parseEnvironmentStep(input, path);
    case "automatic":
      return parseAutomaticStep(input, path);
    case "manual":
      return parseManualStep(input, path);
    case "fire-and-forget":
      return parseFireAndForgetStep(input, path);
    case "prompt":
      return parsePromptStep(input, path);
    case "provider":
      return parseProviderStep(input, path);
    case "install-user-secret":
      return parseInstallUserSecretStep(input, path);
    default:
      fail(
        `${path}.kind`,
        "Expected one of: environment, automatic, manual, fire-and-forget, prompt, provider, install-user-secret.",
      );
  }
};

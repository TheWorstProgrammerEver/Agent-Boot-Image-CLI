import { parseDefinitionUrl } from "./local-reference.js";
import {
  parseProvider,
  type ProviderDefinition,
  type ProviderInput,
} from "./provider.js";
import {
  parseAsset,
  parseOperatingSystem,
  parsePrompt,
  parseRegisteredReference,
  parseSecretReference,
  parseSsid,
  parseScriptReference,
  type AssetDefinition,
  type AssetInput,
  type CuratedOperatingSystem,
  type CuratedOperatingSystemInput,
  type PromptDefinition,
  type PromptInput,
  type ResourceRegistry,
  type ScriptDefinition,
  type SecretDefinition,
  type SecretInput,
} from "./resources.js";
import { parseStep } from "./step-schema.js";
import type { SequenceStep, SequenceStepInput } from "./steps.js";
import {
  assertUnique,
  fail,
  parseArray,
  parseHostname,
  parseIdentifier,
  parseObject,
  parseString,
  parseUsername,
  required,
} from "./validation.js";

export const DEFINITION_SCHEMA_VERSION = 1 as const;

export interface AgentDefinitionInput {
  readonly definitionUrl: string;
  readonly agent: {
    readonly id: string;
    readonly displayName: string;
  };
  readonly operatingSystem: CuratedOperatingSystemInput;
  readonly account: {
    readonly username: string;
    readonly initialPassword?: SecretInput;
  };
  readonly network?: {
    readonly hostname: string;
    readonly wifi?: {
      readonly ssid: string;
      readonly passphrase: SecretInput;
    };
  };
  readonly assets?: readonly AssetInput[];
  readonly prompts?: readonly PromptInput[];
  readonly providers?: readonly ProviderInput[];
  readonly steps: readonly SequenceStepInput[];
}

export interface AgentDefinition {
  schemaVersion: typeof DEFINITION_SCHEMA_VERSION;
  definitionUrl: string;
  agent: {
    id: string;
    displayName: string;
  };
  operatingSystem: CuratedOperatingSystem;
  account: {
    username: string;
    initialPassword?: { secretId: string };
  };
  network?: {
    hostname: string;
    wifi?: {
      ssid: string;
      passphrase: { secretId: string };
    };
  };
  assets: AssetDefinition[];
  prompts: PromptDefinition[];
  scripts: ScriptDefinition[];
  secrets: SecretDefinition[];
  providers: ProviderDefinition[];
  steps: SequenceStep[];
}

export interface AgentDefinitionSchema {
  readonly name: "Agent definition";
  parse(input: unknown): AgentDefinition;
}

const parseVersion = (input: unknown, path: string): typeof DEFINITION_SCHEMA_VERSION => {
  if (input !== undefined && input !== DEFINITION_SCHEMA_VERSION) {
    fail(path, `Expected ${String(DEFINITION_SCHEMA_VERSION)}.`);
  }
  return DEFINITION_SCHEMA_VERSION;
};

const parseSecretUse = (
  input: unknown,
  registry: ResourceRegistry,
  path: string,
): { secretId: string } => {
  const reference =
    typeof input === "object" &&
    input !== null &&
    Object.hasOwn(input, "secretId")
      ? parseRegisteredReference(input, "secret", registry.secrets, path)
      : parseSecretReference(input, registry, path);
  return { secretId: reference.id };
};

const parseAccount = (
  input: unknown,
  registry: ResourceRegistry,
  path: string,
): AgentDefinition["account"] => {
  const value = parseObject(input, path, ["username", "initialPassword"]);
  return {
    username: parseUsername(required(value, "username", path), `${path}.username`),
    ...(value.initialPassword === undefined
      ? {}
      : {
          initialPassword: parseSecretUse(
            value.initialPassword,
            registry,
            `${path}.initialPassword`,
          ),
        }),
  };
};

const parseNetwork = (
  input: unknown,
  registry: ResourceRegistry,
  path: string,
): NonNullable<AgentDefinition["network"]> => {
  const value = parseObject(input, path, ["hostname", "wifi"]);
  const wifiInput = value.wifi;
  let wifi: NonNullable<AgentDefinition["network"]>["wifi"];
  if (wifiInput !== undefined) {
    const wifiValue = parseObject(wifiInput, `${path}.wifi`, ["ssid", "passphrase"]);
    wifi = {
      ssid: parseSsid(required(wifiValue, "ssid", `${path}.wifi`), `${path}.wifi.ssid`),
      passphrase: parseSecretUse(
        required(wifiValue, "passphrase", `${path}.wifi`),
        registry,
        `${path}.wifi.passphrase`,
      ),
    };
  }
  return {
    hostname: parseHostname(required(value, "hostname", path), `${path}.hostname`),
    ...(wifi === undefined ? {} : { wifi }),
  };
};

const validateReferences = (definition: AgentDefinition): void => {
  const promptById = new Map(definition.prompts.map((prompt) => [prompt.id, prompt]));
  const providerIds = new Set(definition.providers.map((provider) => provider.id));
  const renderedPromptIds = new Set<string>();

  for (const [index, step] of definition.steps.entries()) {
    const path = `$.steps[${String(index)}]`;
    if (step.kind === "prompt") {
      const template = promptById.get(step.templateId);
      if (template === undefined) {
        fail(`${path}.templateId`, `Unknown prompt ${JSON.stringify(step.templateId)}.`);
      }
      if (renderedPromptIds.has(step.renderedPromptId)) {
        fail(`${path}.renderedPromptId`, `Duplicate rendered prompt ${JSON.stringify(step.renderedPromptId)}.`);
      }
      renderedPromptIds.add(step.renderedPromptId);
      const declared = new Set(template.variables);
      const bound = new Set(step.variables.map((binding) => binding.name));
      for (const name of declared) {
        if (!bound.has(name)) fail(`${path}.variables`, `Prompt variable ${JSON.stringify(name)} is not bound.`);
      }
      for (const name of bound) {
        if (!declared.has(name)) fail(`${path}.variables`, `Prompt variable ${JSON.stringify(name)} is not declared.`);
      }
    }
    if (step.kind === "provider") {
      if (!providerIds.has(step.providerId)) {
        fail(`${path}.providerId`, `Unknown provider ${JSON.stringify(step.providerId)}.`);
      }
      if (!renderedPromptIds.has(step.renderedPromptId)) {
        fail(`${path}.renderedPromptId`, "Provider prompts must be rendered by an earlier step.");
      }
    }
  }
};

const parseDefinition = (input: unknown): AgentDefinition => {
  const value = parseObject(input, "$", [
    "schemaVersion", "definitionUrl", "agent", "operatingSystem", "account", "network",
    "assets", "prompts", "scripts", "secrets", "providers", "steps",
  ]);
  const definitionUrl = parseDefinitionUrl(
    required(value, "definitionUrl", "$"),
    "$.definitionUrl",
  );
  const registry: ResourceRegistry = {
    definitionUrl,
    scripts: new Map(),
    secrets: new Map(),
  };

  parseArray(value.scripts ?? [], "$.scripts", (item, path) =>
    parseScriptReference(item, registry, path));
  parseArray(value.secrets ?? [], "$.secrets", (item, path) =>
    parseSecretReference(item, registry, path));

  const agent = parseObject(required(value, "agent", "$"), "$.agent", ["id", "displayName"]);
  const assets = parseArray(value.assets ?? [], "$.assets", (item, path) =>
    parseAsset(item, definitionUrl, path));
  const prompts = parseArray(value.prompts ?? [], "$.prompts", (item, path) =>
    parsePrompt(item, definitionUrl, path));
  const account = parseAccount(required(value, "account", "$"), registry, "$.account");
  const networkInput = value.network;
  const providers = parseArray(value.providers ?? [], "$.providers", (item, path) =>
    parseProvider(item, registry, path));
  const steps = parseArray(
    required(value, "steps", "$"),
    "$.steps",
    (item, path) => parseStep(item, registry, path),
    { minLength: 1 },
  );

  assertUnique(assets, "$.assets", (asset) => asset.id);
  assertUnique(prompts, "$.prompts", (prompt) => prompt.id);
  assertUnique(providers, "$.providers", (provider) => provider.id);
  assertUnique(steps, "$.steps", (step) => step.id);

  const definition: AgentDefinition = {
    schemaVersion: parseVersion(value.schemaVersion, "$.schemaVersion"),
    definitionUrl,
    agent: {
      id: parseIdentifier(required(agent, "id", "$.agent"), "$.agent.id"),
      displayName: parseString(
        required(agent, "displayName", "$.agent"),
        "$.agent.displayName",
        { maxLength: 128 },
      ),
    },
    operatingSystem: parseOperatingSystem(
      required(value, "operatingSystem", "$"),
      "$.operatingSystem",
    ),
    account,
    ...(networkInput === undefined
      ? {}
      : { network: parseNetwork(networkInput, registry, "$.network") }),
    assets,
    prompts,
    scripts: [...registry.scripts.values()],
    secrets: [...registry.secrets.values()],
    providers,
    steps,
  };
  validateReferences(definition);
  return definition;
};

export const agentDefinitionSchema: AgentDefinitionSchema = {
  name: "Agent definition",
  parse: parseDefinition,
};

export const defineAgent = (input: AgentDefinitionInput): AgentDefinition =>
  agentDefinitionSchema.parse(input);

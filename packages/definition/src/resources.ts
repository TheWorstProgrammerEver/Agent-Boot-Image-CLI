import type { PublicEnvironmentKey, TargetLocation } from "@agent-boot/protocol";
import {
  localReference,
  parseLocalReference,
  type LocalReference,
  type LocalReferenceInput,
} from "./local-reference.js";
import {
  assertUnique,
  fail,
  parseArray,
  parseEnvironmentKey,
  parseIdentifier,
  parseObject,
  parseString,
  parseTargetLocation,
  required,
} from "./validation.js";

export type SecretInput = LocalReferenceInput<"secret">;
export type SecretDefinition = LocalReference<"secret">;
export type ScriptInput = LocalReferenceInput<"script">;
export type ScriptDefinition = LocalReference<"script">;

export interface AssetInput extends LocalReferenceInput<"asset"> {
  readonly placement?: TargetLocation;
}

export interface AssetDefinition extends LocalReference<"asset"> {
  placement?: TargetLocation;
}

export interface PromptInput extends LocalReferenceInput<"prompt"> {
  readonly variables: readonly string[];
}

export interface PromptDefinition extends LocalReference<"prompt"> {
  variables: string[];
}

export interface CuratedOperatingSystemInput {
  readonly catalogId: string;
  readonly compatibility: {
    readonly architecture: string;
    readonly boards: readonly string[];
  };
}

export interface CuratedOperatingSystem {
  catalogId: string;
  compatibility: {
    architecture: string;
    boards: string[];
  };
}

export type PromptVariableInput =
  | { readonly kind: "environment"; readonly key: PublicEnvironmentKey }
  | { readonly kind: "secret"; readonly secret: SecretInput };

export type PromptVariableSource =
  | { kind: "environment"; key: PublicEnvironmentKey }
  | { kind: "secret"; secretId: string };

export const asset = (
  id: string,
  source: string,
  options: { placement?: TargetLocation } = {},
): AssetInput => ({ ...localReference("asset", id, source), ...options });

export const prompt = (
  id: string,
  source: string,
  variables: readonly string[],
): PromptInput => ({ ...localReference("prompt", id, source), variables });

export const script = (id: string, source: string): ScriptInput =>
  localReference("script", id, source);

export const secret = (id: string, source: string): SecretInput =>
  localReference("secret", id, source);

export const curatedOperatingSystem = (
  catalogId: string,
  compatibility: CuratedOperatingSystemInput["compatibility"],
): CuratedOperatingSystemInput => ({ catalogId, compatibility });

export const fromEnvironment = (key: PublicEnvironmentKey): PromptVariableInput => ({
  kind: "environment",
  key,
});

export const fromSecret = (value: SecretInput): PromptVariableInput => ({
  kind: "secret",
  secret: value,
});

export const parseAsset = (
  input: unknown,
  definitionUrl: string,
  path: string,
): AssetDefinition => {
  const value = parseObject(input, path, ["kind", "id", "source", "placement"]);
  const reference = parseLocalReference(
    { kind: value.kind, id: value.id, source: value.source },
    "asset",
    definitionUrl,
    path,
  );
  const placement = value.placement;
  return {
    ...reference,
    ...(placement === undefined
      ? {}
      : { placement: parseTargetLocation(placement, `${path}.placement`) }),
  };
};

export const parsePrompt = (
  input: unknown,
  definitionUrl: string,
  path: string,
): PromptDefinition => {
  const value = parseObject(input, path, ["kind", "id", "source", "variables"]);
  const reference = parseLocalReference(
    { kind: value.kind, id: value.id, source: value.source },
    "prompt",
    definitionUrl,
    path,
  );
  const variables = parseArray(
    required(value, "variables", path),
    `${path}.variables`,
    parseIdentifier,
    { maxLength: 128 },
  );
  assertUnique(variables, `${path}.variables`, (variable) => variable);
  return { ...reference, variables };
};

export const parseOperatingSystem = (
  input: unknown,
  path: string,
): CuratedOperatingSystem => {
  const value = parseObject(input, path, ["catalogId", "compatibility"]);
  const compatibility = parseObject(
    required(value, "compatibility", path),
    `${path}.compatibility`,
    ["architecture", "boards"],
  );
  const boards = parseArray(
    required(compatibility, "boards", `${path}.compatibility`),
    `${path}.compatibility.boards`,
    parseIdentifier,
    { minLength: 1, maxLength: 64 },
  );
  assertUnique(boards, `${path}.compatibility.boards`, (board) => board);
  return {
    catalogId: parseIdentifier(required(value, "catalogId", path), `${path}.catalogId`),
    compatibility: {
      architecture: parseIdentifier(
        required(compatibility, "architecture", `${path}.compatibility`),
        `${path}.compatibility.architecture`,
      ),
      boards,
    },
  };
};

export interface ResourceRegistry {
  readonly definitionUrl: string;
  readonly scripts: Map<string, ScriptDefinition>;
  readonly secrets: Map<string, SecretDefinition>;
}

const register = <K extends "script" | "secret">(
  registry: Map<string, LocalReference<K>>,
  reference: LocalReference<K>,
  path: string,
): LocalReference<K> => {
  const previous = registry.get(reference.id);
  if (previous !== undefined && previous.source.url !== reference.source.url) {
    fail(path, `Conflicting local sources for ${reference.kind} ${JSON.stringify(reference.id)}.`);
  }
  registry.set(reference.id, reference);
  return reference;
};

export const parseScriptReference = (
  input: unknown,
  registry: ResourceRegistry,
  path: string,
): ScriptDefinition =>
  register(
    registry.scripts,
    parseLocalReference(input, "script", registry.definitionUrl, path),
    path,
  );

export const parseSecretReference = (
  input: unknown,
  registry: ResourceRegistry,
  path: string,
): SecretDefinition =>
  register(
    registry.secrets,
    parseLocalReference(input, "secret", registry.definitionUrl, path),
    path,
  );

export const parseRegisteredReference = <K extends "script" | "secret">(
  input: unknown,
  kind: K,
  registry: Map<string, LocalReference<K>>,
  path: string,
): LocalReference<K> => {
  const value = parseObject(input, path, [`${kind}Id`]);
  const id = parseIdentifier(required(value, `${kind}Id`, path), `${path}.${kind}Id`);
  const reference = registry.get(id);
  if (reference === undefined) {
    fail(path, `Unknown ${kind} reference ${JSON.stringify(id)}.`);
  }
  return reference;
};

export const parsePromptVariableSource = (
  input: unknown,
  registry: ResourceRegistry,
  path: string,
): PromptVariableSource => {
  const discriminator = parseObject(input, path, ["kind", "key", "secret", "secretId"]);
  const kind = required(discriminator, "kind", path);
  if (kind === "environment") {
    const value = parseObject(input, path, ["kind", "key"]);
    return {
      kind,
      key: parseEnvironmentKey(required(value, "key", path), `${path}.key`),
    };
  }
  if (kind === "secret") {
    const value = parseObject(input, path, ["kind", "secret", "secretId"]);
    const reference = Object.hasOwn(value, "secret")
      ? parseSecretReference(
          required(value, "secret", path),
          registry,
          `${path}.secret`,
        )
      : parseRegisteredReference(
          { secretId: value.secretId },
          "secret",
          registry.secrets,
          path,
        );
    return {
      kind,
      secretId: reference.id,
    };
  }
  fail(`${path}.kind`, "Expected one of: environment, secret.");
};

export const parseSsid = (input: unknown, path: string): string =>
  parseString(input, path, { maxLength: 32 });

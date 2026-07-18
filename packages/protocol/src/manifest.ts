import {
  parseHostname,
  parseIdentifier,
  parsePrefixedPath,
  parseSecretReference,
  parseSha256,
  parseTargetLocation,
  parseUsername,
  SCHEMA_VERSION,
  type SchemaVersion,
  type SecretReference,
  type TargetLocation,
} from "./common.js";
import {
  assertUnique,
  createRuntimeSchema,
  fail,
  optional,
  parseArray,
  parseInteger,
  parseLiteral,
  parseObject,
  parseString,
  required,
  type Parser,
} from "./schema.js";

export const ASSEMBLY_PATHS = {
  assets: "assets",
  manifest: "manifest.json",
  osLock: "os-lock.json",
  prompts: "prompts",
  runnerPlan: "runner-plan.json",
} as const;

export interface AssetDescriptor {
  id: string;
  path: string;
  sha256: string;
  byteLength: number;
  placement?: TargetLocation;
}

export interface PromptDescriptor {
  id: string;
  path: string;
  sha256: string;
  variables: string[];
}

export interface AccountBootstrapDescriptor {
  username: string;
  initialPassword?: SecretReference;
}

export interface WifiBootstrapDescriptor {
  ssid: string;
  passphrase: SecretReference;
}

export interface NetworkBootstrapDescriptor {
  hostname: string;
  wifi?: WifiBootstrapDescriptor;
}

export interface RunnerInstallationDescriptor {
  runtimeAssetId: string;
  entrypointAssetId: string;
}

export interface BootstrapDescriptor {
  account: AccountBootstrapDescriptor;
  network?: NetworkBootstrapDescriptor;
  runnerInstallation: RunnerInstallationDescriptor;
}

export interface AssemblyManifest {
  schemaVersion: SchemaVersion;
  assemblyId: string;
  agent: {
    id: string;
    displayName: string;
  };
  files: {
    runnerPlan: typeof ASSEMBLY_PATHS.runnerPlan;
    osLock: typeof ASSEMBLY_PATHS.osLock;
    assetsDirectory: typeof ASSEMBLY_PATHS.assets;
    promptsDirectory: typeof ASSEMBLY_PATHS.prompts;
  };
  bootstrap: BootstrapDescriptor;
  assets: AssetDescriptor[];
  prompts: PromptDescriptor[];
}

const parseAsset: Parser<AssetDescriptor> = (input, path) => {
  const value = parseObject(input, path, ["id", "path", "sha256", "byteLength", "placement"]);
  const placement = optional(value, "placement");
  return {
    id: parseIdentifier(required(value, "id", path), `${path}.id`),
    path: parsePrefixedPath(required(value, "path", path), `${path}.path`, "assets"),
    sha256: parseSha256(required(value, "sha256", path), `${path}.sha256`),
    byteLength: parseInteger(required(value, "byteLength", path), `${path}.byteLength`, {
      minimum: 0,
    }),
    ...(placement === undefined
      ? {}
      : { placement: parseTargetLocation(placement, `${path}.placement`) }),
  };
};

const parsePrompt: Parser<PromptDescriptor> = (input, path) => {
  const value = parseObject(input, path, ["id", "path", "sha256", "variables"]);
  const variables = parseArray(
    required(value, "variables", path),
    `${path}.variables`,
    parseIdentifier,
    { maxLength: 128 },
  );
  assertUnique(variables, `${path}.variables`, (variable) => variable);
  return {
    id: parseIdentifier(required(value, "id", path), `${path}.id`),
    path: parsePrefixedPath(required(value, "path", path), `${path}.path`, "prompts"),
    sha256: parseSha256(required(value, "sha256", path), `${path}.sha256`),
    variables,
  };
};

const parseAccount: Parser<AccountBootstrapDescriptor> = (input, path) => {
  const value = parseObject(input, path, ["username", "initialPassword"]);
  const initialPassword = optional(value, "initialPassword");
  return {
    username: parseUsername(required(value, "username", path), `${path}.username`),
    ...(initialPassword === undefined
      ? {}
      : { initialPassword: parseSecretReference(initialPassword, `${path}.initialPassword`) }),
  };
};

const parseWifi: Parser<WifiBootstrapDescriptor> = (input, path) => {
  const value = parseObject(input, path, ["ssid", "passphrase"]);
  return {
    ssid: parseString(required(value, "ssid", path), `${path}.ssid`, { maxLength: 32 }),
    passphrase: parseSecretReference(required(value, "passphrase", path), `${path}.passphrase`),
  };
};

const parseNetwork: Parser<NetworkBootstrapDescriptor> = (input, path) => {
  const value = parseObject(input, path, ["hostname", "wifi"]);
  const wifi = optional(value, "wifi");
  return {
    hostname: parseHostname(required(value, "hostname", path), `${path}.hostname`),
    ...(wifi === undefined ? {} : { wifi: parseWifi(wifi, `${path}.wifi`) }),
  };
};

const parseRunnerInstallation: Parser<RunnerInstallationDescriptor> = (input, path) => {
  const value = parseObject(input, path, ["runtimeAssetId", "entrypointAssetId"]);
  return {
    runtimeAssetId: parseIdentifier(
      required(value, "runtimeAssetId", path),
      `${path}.runtimeAssetId`,
    ),
    entrypointAssetId: parseIdentifier(
      required(value, "entrypointAssetId", path),
      `${path}.entrypointAssetId`,
    ),
  };
};

const parseBootstrap: Parser<BootstrapDescriptor> = (input, path) => {
  const value = parseObject(input, path, ["account", "network", "runnerInstallation"]);
  const network = optional(value, "network");
  return {
    account: parseAccount(required(value, "account", path), `${path}.account`),
    ...(network === undefined ? {} : { network: parseNetwork(network, `${path}.network`) }),
    runnerInstallation: parseRunnerInstallation(
      required(value, "runnerInstallation", path),
      `${path}.runnerInstallation`,
    ),
  };
};

const parseManifest = (input: unknown, path: string): AssemblyManifest => {
  const value = parseObject(input, path, [
    "schemaVersion",
    "assemblyId",
    "agent",
    "files",
    "bootstrap",
    "assets",
    "prompts",
  ]);
  const agent = parseObject(required(value, "agent", path), `${path}.agent`, ["id", "displayName"]);
  const files = parseObject(required(value, "files", path), `${path}.files`, [
    "runnerPlan",
    "osLock",
    "assetsDirectory",
    "promptsDirectory",
  ]);
  const assets = parseArray(required(value, "assets", path), `${path}.assets`, parseAsset);
  const prompts = parseArray(required(value, "prompts", path), `${path}.prompts`, parsePrompt);
  assertUnique(assets, `${path}.assets`, (asset) => asset.id);
  assertUnique(prompts, `${path}.prompts`, (prompt) => prompt.id);

  const bootstrap = parseBootstrap(required(value, "bootstrap", path), `${path}.bootstrap`);
  const assetIds = new Set(assets.map((asset) => asset.id));
  const { runtimeAssetId, entrypointAssetId } = bootstrap.runnerInstallation;
  for (const assetId of [runtimeAssetId, entrypointAssetId]) {
    if (!assetIds.has(assetId)) {
      fail(`${path}.bootstrap.runnerInstallation`, `Unknown asset reference ${JSON.stringify(assetId)}.`);
    }
  }

  return {
    schemaVersion: parseLiteral(
      required(value, "schemaVersion", path),
      `${path}.schemaVersion`,
      SCHEMA_VERSION,
    ),
    assemblyId: parseIdentifier(required(value, "assemblyId", path), `${path}.assemblyId`),
    agent: {
      id: parseIdentifier(required(agent, "id", `${path}.agent`), `${path}.agent.id`),
      displayName: parseString(
        required(agent, "displayName", `${path}.agent`),
        `${path}.agent.displayName`,
        { maxLength: 128 },
      ),
    },
    files: {
      runnerPlan: parseLiteral(
        required(files, "runnerPlan", `${path}.files`),
        `${path}.files.runnerPlan`,
        ASSEMBLY_PATHS.runnerPlan,
      ),
      osLock: parseLiteral(
        required(files, "osLock", `${path}.files`),
        `${path}.files.osLock`,
        ASSEMBLY_PATHS.osLock,
      ),
      assetsDirectory: parseLiteral(
        required(files, "assetsDirectory", `${path}.files`),
        `${path}.files.assetsDirectory`,
        ASSEMBLY_PATHS.assets,
      ),
      promptsDirectory: parseLiteral(
        required(files, "promptsDirectory", `${path}.files`),
        `${path}.files.promptsDirectory`,
        ASSEMBLY_PATHS.prompts,
      ),
    },
    bootstrap,
    assets,
    prompts,
  };
};

export const manifestSchema = createRuntimeSchema("manifest.json", parseManifest);

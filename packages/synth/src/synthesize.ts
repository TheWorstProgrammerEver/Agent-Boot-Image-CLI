import { createHash } from "node:crypto";

import {
  canonicalJsonBytes,
  type AssemblyFile,
} from "@agent-boot/assembly";
import type { AgentDefinition } from "@agent-boot/definition";
import {
  ASSEMBLY_PATHS,
  SCHEMA_VERSION,
  ProtocolValidationError,
  assemblyDocumentsSchema,
  osLockSchema,
  type AssemblyDocuments,
  type AssemblyManifest,
  type AssetDescriptor,
  type OsLock,
} from "@agent-boot/protocol";

import { SynthesisError } from "./errors.js";
import { createResourceFiles, sha256 } from "./resources.js";
import { createRunnerPlan } from "./runner-plan.js";
import { collectSourceFiles, type SourceFileAccess } from "./source-files.js";

export interface RunnerArtifacts {
  readonly runtime: Uint8Array;
  readonly entrypoint: Uint8Array;
}

export interface SynthesizeAssemblyOptions {
  readonly osLock: unknown;
  readonly runnerArtifacts: RunnerArtifacts;
  readonly sourceFileAccess?: SourceFileAccess;
}

export interface SynthesizedAssembly {
  readonly assemblyId: string;
  readonly documents: AssemblyDocuments;
  readonly files: readonly AssemblyFile[];
  readonly copied: {
    readonly assets: number;
    readonly prompts: number;
    readonly scripts: number;
  };
}

const assetDescriptor = (
  id: string,
  path: string,
  contents: Uint8Array,
  placement?: AssetDescriptor["placement"],
): AssetDescriptor => ({
  id,
  path,
  sha256: sha256(contents),
  byteLength: contents.byteLength,
  ...(placement === undefined ? {} : { placement }),
});

const validateOsLock = (definition: AgentDefinition, input: unknown): OsLock => {
  let osLock: OsLock;
  try {
    osLock = osLockSchema.parse(input);
  } catch (error) {
    if (error instanceof ProtocolValidationError) {
      throw new SynthesisError("invalid-input", "The resolved OS lock is invalid.", error.path);
    }
    throw error;
  }
  if (osLock.operatingSystem.architecture !== definition.operatingSystem.compatibility.architecture) {
    throw new SynthesisError(
      "invalid-input",
      "The resolved OS lock architecture is incompatible with the definition.",
      "$.operatingSystem.compatibility.architecture",
    );
  }
  const supportedBoards = new Set(osLock.operatingSystem.boards);
  if (!definition.operatingSystem.compatibility.boards.every((board) => supportedBoards.has(board))) {
    throw new SynthesisError(
      "invalid-input",
      "The resolved OS lock does not support every requested board.",
      "$.operatingSystem.compatibility.boards",
    );
  }
  return osLock;
};

export const synthesizeAssembly = async (
  definition: AgentDefinition,
  options: SynthesizeAssemblyOptions,
): Promise<SynthesizedAssembly> => {
  if (options.runnerArtifacts.runtime.byteLength === 0 || options.runnerArtifacts.entrypoint.byteLength === 0) {
    throw new SynthesisError("invalid-input", "Runner artifacts must not be empty.");
  }
  const osLock = validateOsLock(definition, options.osLock);
  const collected = await collectSourceFiles(definition, options.sourceFileAccess);
  const resources = createResourceFiles(definition, collected);
  const runnerPlan = createRunnerPlan(definition);

  const runtimePath = `${ASSEMBLY_PATHS.assets}/runner/runtime`;
  const entrypointPath = `${ASSEMBLY_PATHS.assets}/runner/entrypoint.mjs`;
  const runnerAssets: AssetDescriptor[] = [
    assetDescriptor("runner-runtime", runtimePath, options.runnerArtifacts.runtime, {
      scope: "system",
      path: "opt/agent-boot/runtime/node",
    }),
    assetDescriptor("runner-entrypoint", entrypointPath, options.runnerArtifacts.entrypoint, {
      scope: "system",
      path: "opt/agent-boot/runner.mjs",
    }),
  ];
  const contentFiles: AssemblyFile[] = [
    { path: runtimePath, contents: options.runnerArtifacts.runtime, mode: 0o755 },
    { path: entrypointPath, contents: options.runnerArtifacts.entrypoint, mode: 0o755 },
    ...resources.files,
  ];
  const identityHash = createHash("sha256");
  identityHash.update(canonicalJsonBytes({
    agent: definition.agent,
    bootstrap: { account: definition.account, network: definition.network },
    osLock,
    runnerPlan,
    assets: [...runnerAssets, ...resources.assets],
    prompts: resources.prompts,
  }));
  for (const file of [...contentFiles].sort((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0)) {
    identityHash.update(file.path);
    identityHash.update("\0");
    identityHash.update(file.contents);
    identityHash.update("\0");
  }
  const assemblyId = `assembly-${identityHash.digest("hex").slice(0, 32)}`;
  const manifest: AssemblyManifest = {
    schemaVersion: SCHEMA_VERSION,
    assemblyId,
    agent: definition.agent,
    files: {
      runnerPlan: ASSEMBLY_PATHS.runnerPlan,
      osLock: ASSEMBLY_PATHS.osLock,
      assetsDirectory: ASSEMBLY_PATHS.assets,
      promptsDirectory: ASSEMBLY_PATHS.prompts,
    },
    bootstrap: {
      account: definition.account,
      ...(definition.network === undefined ? {} : { network: definition.network }),
      runnerInstallation: {
        runtimeAssetId: "runner-runtime",
        entrypointAssetId: "runner-entrypoint",
      },
    },
    assets: [...runnerAssets, ...resources.assets],
    prompts: resources.prompts,
  };
  const documents = assemblyDocumentsSchema.parse({ manifest, runnerPlan, osLock });
  const documentFiles: AssemblyFile[] = [
    { path: ASSEMBLY_PATHS.manifest, contents: canonicalJsonBytes(manifest), mode: 0o644 },
    { path: ASSEMBLY_PATHS.runnerPlan, contents: canonicalJsonBytes(runnerPlan), mode: 0o644 },
    { path: ASSEMBLY_PATHS.osLock, contents: canonicalJsonBytes(osLock), mode: 0o644 },
  ];
  return {
    assemblyId,
    documents,
    files: [...documentFiles, ...contentFiles].sort((left, right) =>
      left.path < right.path ? -1 : left.path > right.path ? 1 : 0),
    copied: {
      assets: definition.assets.length,
      prompts: definition.prompts.length,
      scripts: definition.scripts.length,
    },
  };
};

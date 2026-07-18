import { lstat } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import type { AgentDefinition } from "@agent-boot/definition";

import {
  DefinitionLoaderError,
  InvalidDefinitionError,
} from "./validation-errors.js";

export interface ReferenceMetadata {
  readonly isFile: boolean;
  readonly isSymbolicLink: boolean;
}

export type ReferenceMetadataInspector = (url: URL) => Promise<ReferenceMetadata>;

const inspectMetadata: ReferenceMetadataInspector = async (url) => {
  const metadata = await lstat(fileURLToPath(url));
  return {
    isFile: metadata.isFile(),
    isSymbolicLink: metadata.isSymbolicLink(),
  };
};

interface ReferenceDescriptor {
  readonly path: string;
  readonly url: string;
}

const referencesFrom = (definition: AgentDefinition): ReferenceDescriptor[] => [
  ...definition.assets.map((reference, index) => ({
    path: `$.assets[${String(index)}].source.url`,
    url: reference.source.url,
  })),
  ...definition.prompts.map((reference, index) => ({
    path: `$.prompts[${String(index)}].source.url`,
    url: reference.source.url,
  })),
  ...definition.scripts.map((reference, index) => ({
    path: `$.scripts[${String(index)}].source.url`,
    url: reference.source.url,
  })),
  ...definition.secrets.map((reference, index) => ({
    path: `$.secrets[${String(index)}].source.url`,
    url: reference.source.url,
  })),
];

const isMissingReference = (error: unknown): boolean =>
  error instanceof Error && "code" in error && error.code === "ENOENT";

export const validateReferenceMetadata = async (
  definition: AgentDefinition,
  definitionPath: string,
  inspect: ReferenceMetadataInspector = inspectMetadata,
): Promise<number> => {
  const references = referencesFrom(definition);
  for (const reference of references) {
    let metadata: ReferenceMetadata;
    try {
      metadata = await inspect(new URL(reference.url));
    } catch (error) {
      if (isMissingReference(error)) {
        throw new InvalidDefinitionError(
          definitionPath,
          "The referenced file does not exist.",
          reference.path,
        );
      }
      throw new DefinitionLoaderError(definitionPath);
    }
    if (!metadata.isFile || metadata.isSymbolicLink) {
      throw new InvalidDefinitionError(
        definitionPath,
        "Expected a regular file that is not a symbolic link.",
        reference.path,
      );
    }
  }
  return references.length;
};

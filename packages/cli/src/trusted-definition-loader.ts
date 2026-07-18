import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  DEFINITION_SCHEMA_VERSION,
  DefinitionValidationError,
  agentDefinitionSchema,
  type AgentDefinition,
} from "@agent-boot/definition";
import {
  SchemaCompatibilityError,
  assertCompatibleSchemaVersion,
} from "@agent-boot/protocol";

import {
  type ReferenceMetadataInspector,
  validateReferenceMetadata,
} from "./reference-metadata.js";
import {
  DefinitionLoaderError,
  IncompatibleDefinitionError,
  InvalidDefinitionError,
} from "./validation-errors.js";

export interface LoadTrustedDefinitionOptions {
  readonly inspectReferenceMetadata?: ReferenceMetadataInspector;
}

export interface LoadedTrustedDefinition {
  readonly definition: AgentDefinition;
  readonly definitionPath: string;
  readonly referenceCount: number;
}

const sourceLocationFrom = (
  error: unknown,
  definitionUrl: string,
  definitionPath: string,
): string | undefined => {
  if (!(error instanceof Error) || error.stack === undefined) return undefined;
  const sourceLine = error.stack
    .split("\n")
    .find((line) => line.includes(definitionUrl) || line.includes(definitionPath));
  const match = /:(\d+)(?::(\d+))?\)?$/u.exec(sourceLine ?? "");
  if (match?.[1] === undefined) return undefined;
  return match[2] === undefined ? match[1] : `${match[1]}:${match[2]}`;
};

const safeValidationReason = (error: DefinitionValidationError): string => {
  const prefix = `Agent definition validation failed at ${error.path}: `;
  const reason = error.message.startsWith(prefix)
    ? error.message.slice(prefix.length)
    : "The exported value does not satisfy the agent definition schema.";
  return reason.replace(/"(?:[^"\\]|\\.)*"/gu, '"<redacted>"');
};

const asObjectWithActualDefinitionUrl = (
  exported: unknown,
  definitionUrl: string,
  definitionPath: string,
): unknown => {
  if (typeof exported !== "object" || exported === null || Array.isArray(exported)) {
    return exported;
  }
  if (
    Object.hasOwn(exported, "definitionUrl") &&
    (exported as Record<string, unknown>).definitionUrl !== definitionUrl
  ) {
    throw new InvalidDefinitionError(
      definitionPath,
      "Use import.meta.url so references are rooted at this definition file.",
      "$.definitionUrl",
    );
  }
  return { ...(exported as Record<string, unknown>), definitionUrl };
};

const assertCompatible = (exported: unknown, definitionPath: string): void => {
  if (
    typeof exported !== "object" ||
    exported === null ||
    !Object.hasOwn(exported, "schemaVersion")
  ) return;
  try {
    assertCompatibleSchemaVersion(
      "create-agent validate",
      "agent definition",
      (exported as Record<string, unknown>).schemaVersion,
      [DEFINITION_SCHEMA_VERSION],
    );
  } catch (error) {
    if (error instanceof SchemaCompatibilityError) {
      throw new IncompatibleDefinitionError(definitionPath);
    }
    throw error;
  }
};

const importDefinition = async (
  definitionUrl: string,
  definitionPath: string,
): Promise<Record<string, unknown>> => {
  try {
    return await import(definitionUrl) as Record<string, unknown>;
  } catch (error) {
    if (error instanceof DefinitionValidationError) {
      if (error.path === "$.schemaVersion") {
        throw new IncompatibleDefinitionError(definitionPath);
      }
      throw new InvalidDefinitionError(
        definitionPath,
        safeValidationReason(error),
        error.path,
      );
    }
    if (error instanceof SyntaxError) {
      const location = sourceLocationFrom(error, definitionUrl, definitionPath);
      const suffix = location === undefined ? "." : ` near line ${location}.`;
      throw new InvalidDefinitionError(
        definitionPath,
        `The trusted TypeScript module could not be parsed${suffix}`,
      );
    }
    throw new DefinitionLoaderError(
      definitionPath,
      sourceLocationFrom(error, definitionUrl, definitionPath),
    );
  }
};

export const loadTrustedDefinition = async (
  sourcePath: string,
  options: LoadTrustedDefinitionOptions = {},
): Promise<LoadedTrustedDefinition> => {
  const requestedPath = resolve(sourcePath);
  let definitionPath: string;
  try {
    definitionPath = await realpath(requestedPath);
  } catch {
    throw new DefinitionLoaderError(requestedPath);
  }
  const definitionUrl = pathToFileURL(definitionPath).href;
  const module = await importDefinition(definitionUrl, definitionPath);
  const exports = Object.keys(module);
  if (exports.length !== 1 || exports[0] !== "default") {
    throw new InvalidDefinitionError(
      definitionPath,
      "Export exactly one value: the agent definition as the default export.",
    );
  }

  assertCompatible(module.default, definitionPath);
  const exported = asObjectWithActualDefinitionUrl(
    module.default,
    definitionUrl,
    definitionPath,
  );
  let definition: AgentDefinition;
  try {
    definition = agentDefinitionSchema.parse(exported);
  } catch (error) {
    if (error instanceof DefinitionValidationError) {
      throw new InvalidDefinitionError(
        definitionPath,
        safeValidationReason(error),
        error.path,
      );
    }
    throw error;
  }
  const referenceCount = await validateReferenceMetadata(
    definition,
    definitionPath,
    options.inspectReferenceMetadata,
  );
  return { definition, definitionPath, referenceCount };
};

export type { ReferenceMetadata, ReferenceMetadataInspector } from "./reference-metadata.js";

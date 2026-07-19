import {
  DefinitionLoaderError,
  IncompatibleDefinitionError,
  InvalidDefinitionError,
} from "./validation-errors.js";
import { loadTrustedDefinition } from "./trusted-definition-loader.js";
import { runSynthCommand } from "./synth-command.js";

export const VALIDATION_EXIT_CODE = {
  valid: 0,
  invalidDefinition: 2,
  incompatibleProtocol: 3,
  operationalLoaderFailure: 4,
  usage: 64,
} as const;

export const CREATE_AGENT_EXIT_CODE = {
  ...VALIDATION_EXIT_CODE,
  invalidSynthesisInput: 5,
  outputExists: 6,
  synthesisFailure: 7,
} as const;

export type ValidationExitCode =
  typeof VALIDATION_EXIT_CODE[keyof typeof VALIDATION_EXIT_CODE];

export type CreateAgentExitCode =
  typeof CREATE_AGENT_EXIT_CODE[keyof typeof CREATE_AGENT_EXIT_CODE];

export interface CommandIo {
  readonly stdout: (line: string) => void;
  readonly stderr: (line: string) => void;
}

const TRUST_WARNING =
  "WARNING: TypeScript definitions and their imports are trusted executable code.";

const locationSuffix = (error: DefinitionLoaderError): string =>
  error.location === undefined ? "" : `:${error.location}`;

export const runCreateAgent = async (
  arguments_: readonly string[],
  io: CommandIo,
): Promise<CreateAgentExitCode> => {
  if (arguments_[0] === "synth") {
    io.stderr(TRUST_WARNING);
    return runSynthCommand(arguments_.slice(1), io);
  }

  const definitionPath = arguments_.length === 2 && arguments_[0] === "validate"
    ? arguments_[1]
    : arguments_.length === 3 && arguments_[0] === "validate" && arguments_[1] === "--definition"
      ? arguments_[2]
      : undefined;
  if (definitionPath === undefined) {
    io.stderr("Usage: create-agent validate [--definition] <definition.ts>");
    return VALIDATION_EXIT_CODE.usage;
  }

  io.stderr(TRUST_WARNING);
  try {
    const loaded = await loadTrustedDefinition(definitionPath);
    io.stdout(`Definition valid: ${loaded.definitionPath}`);
    io.stdout(`Agent: ${loaded.definition.agent.id}`);
    io.stdout(`Schema version: ${String(loaded.definition.schemaVersion)}`);
    io.stdout(
      `References: ${String(loaded.referenceCount)} metadata checks passed; contents were not read.`,
    );
    return VALIDATION_EXIT_CODE.valid;
  } catch (error) {
    if (error instanceof IncompatibleDefinitionError) {
      io.stderr(`Incompatible protocol: ${error.definitionPath}: ${error.message}`);
      return VALIDATION_EXIT_CODE.incompatibleProtocol;
    }
    if (error instanceof InvalidDefinitionError) {
      const field = error.fieldPath === undefined ? "" : `:${error.fieldPath}`;
      io.stderr(`Invalid definition: ${error.definitionPath}${field}: ${error.message}`);
      return VALIDATION_EXIT_CODE.invalidDefinition;
    }
    if (error instanceof DefinitionLoaderError) {
      io.stderr(
        `Loader failure: ${error.definitionPath}${locationSuffix(error)}: ${error.message}`,
      );
      return VALIDATION_EXIT_CODE.operationalLoaderFailure;
    }
    io.stderr("Loader failure: validation stopped after an unexpected operational error.");
    return VALIDATION_EXIT_CODE.operationalLoaderFailure;
  }
};

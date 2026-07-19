import { writeAssemblyAtomically } from "@agent-boot/assembly";
import { ProtocolValidationError, osLockSchema } from "@agent-boot/protocol";
import { SynthesisError, synthesizeAssembly } from "@agent-boot/synth";

import { readRegularInputFile } from "./input-file.js";
import { loadTrustedDefinition } from "./trusted-definition-loader.js";
import type { CommandIo, CreateAgentExitCode } from "./validate-command.js";
import {
  DefinitionLoaderError,
  IncompatibleDefinitionError,
  InvalidDefinitionError,
} from "./validation-errors.js";

interface SynthArguments {
  readonly definition: string;
  readonly output: string;
  readonly osLock: string;
  readonly runnerRuntime: string;
  readonly runnerEntrypoint: string;
  readonly replace: boolean;
  readonly plan: boolean;
}

const valueFlags = new Set([
  "--definition",
  "--output",
  "--os-lock",
  "--runner-runtime",
  "--runner-entrypoint",
]);

const parseArguments = (arguments_: readonly string[]): SynthArguments | undefined => {
  const values = new Map<string, string>();
  let replace = false;
  let plan = false;
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index] as string;
    if (argument === "--replace") {
      if (replace) return undefined;
      replace = true;
      continue;
    }
    if (argument === "--plan") {
      if (plan) return undefined;
      plan = true;
      continue;
    }
    if (!valueFlags.has(argument) || values.has(argument)) return undefined;
    const value = arguments_[index + 1];
    if (value === undefined || value.startsWith("--")) return undefined;
    values.set(argument, value);
    index += 1;
  }
  const definition = values.get("--definition");
  const output = values.get("--output");
  const osLock = values.get("--os-lock");
  const runnerRuntime = values.get("--runner-runtime");
  const runnerEntrypoint = values.get("--runner-entrypoint");
  if (
    definition === undefined || output === undefined || osLock === undefined ||
    runnerRuntime === undefined || runnerEntrypoint === undefined
  ) return undefined;
  return { definition, output, osLock, runnerRuntime, runnerEntrypoint, replace, plan };
};

const SYNTH_USAGE =
  "Usage: create-agent synth --definition <definition.ts> --output <directory> " +
  "--os-lock <os-lock.json> --runner-runtime <file> --runner-entrypoint <file> " +
  "[--replace] [--plan]";

const parseOsLock = (contents: Buffer): unknown => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents.toString("utf8")) as unknown;
  } catch {
    throw new SynthesisError("invalid-input", "The resolved OS lock is not valid JSON.");
  }
  try {
    return osLockSchema.parse(parsed);
  } catch (error) {
    if (error instanceof ProtocolValidationError) {
      throw new SynthesisError("invalid-input", "The resolved OS lock is invalid.", error.path);
    }
    throw error;
  }
};

const safeFieldPath = (fieldPath: string | undefined): string => {
  if (
    fieldPath === undefined ||
    /(?:api[-_]?key|credential|passphrase|password|pem|private[-_]?key|secret|token)/iu.test(fieldPath)
  ) return "";
  return ` at ${fieldPath}`;
};

const safeField = (error: SynthesisError): string => safeFieldPath(error.fieldPath);

export const runSynthCommand = async (
  arguments_: readonly string[],
  io: CommandIo,
): Promise<CreateAgentExitCode> => {
  const parsed = parseArguments(arguments_);
  if (parsed === undefined) {
    io.stderr(SYNTH_USAGE);
    return 64;
  }

  try {
    const [loaded, osLockBytes, runtime, entrypoint] = await Promise.all([
      loadTrustedDefinition(parsed.definition),
      readRegularInputFile(parsed.osLock),
      readRegularInputFile(parsed.runnerRuntime),
      readRegularInputFile(parsed.runnerEntrypoint),
    ]);
    const assembly = await synthesizeAssembly(loaded.definition, {
      osLock: parseOsLock(osLockBytes),
      runnerArtifacts: { runtime, entrypoint },
    });
    io.stdout(`Synthesis plan: agent ${loaded.definition.agent.id}; assembly ${assembly.assemblyId}.`);
    io.stdout(
      `Copy plan: ${String(assembly.copied.assets)} assets, ` +
      `${String(assembly.copied.prompts)} prompts, ${String(assembly.copied.scripts)} scripts; ` +
      "secret contents excluded.",
    );
    if (parsed.plan) {
      io.stdout("Plan only: no assembly output was written.");
      return 0;
    }
    try {
      await writeAssemblyAtomically(parsed.output, assembly.files, { replace: parsed.replace });
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("Output already exists;")) {
        io.stderr("Synthesis refused: output already exists; pass --replace explicitly.");
        return 6;
      }
      io.stderr("Synthesis failed: assembly output could not be published atomically.");
      return 7;
    }
    io.stdout("Assembly written successfully.");
    return 0;
  } catch (error) {
    if (error instanceof IncompatibleDefinitionError) {
      io.stderr("Synthesis input rejected: the definition protocol is incompatible.");
      return 3;
    }
    if (error instanceof InvalidDefinitionError) {
      const field = safeFieldPath(error.fieldPath);
      io.stderr(`Synthesis input rejected${field}: the definition is invalid.`);
      return 2;
    }
    if (error instanceof DefinitionLoaderError) {
      io.stderr("Synthesis failed: the trusted definition or reference metadata could not be loaded.");
      return 4;
    }
    if (error instanceof SynthesisError) {
      io.stderr(`Synthesis input rejected${safeField(error)}: ${error.message}`);
      return error.kind === "operational" ? 7 : 5;
    }
    io.stderr("Synthesis failed: an input could not be read or processed.");
    return 7;
  }
};

import type { TargetLocation } from "@agent-boot/protocol";
import {
  parseScriptReference,
  parseRegisteredReference,
  type ResourceRegistry,
  type ScriptInput,
} from "./resources.js";
import {
  parseArray,
  parseObject,
  parseString,
  parseTargetLocation,
  required,
} from "./validation.js";

const MAX_COMMAND_ARGUMENT_LENGTH = 1024;

export type CommandExecutableInput = string | ScriptInput;
export type CommandExecutable = string | { scriptId: string };

export interface CommandInput {
  readonly executable: CommandExecutableInput;
  readonly arguments: readonly string[];
  readonly workingDirectory?: TargetLocation;
}

export interface DefinitionCommand {
  executable: CommandExecutable;
  arguments: string[];
  workingDirectory?: TargetLocation;
}

export const command = (
  executable: CommandExecutableInput,
  arguments_: readonly string[] = [],
  options: { workingDirectory?: TargetLocation } = {},
): CommandInput => ({ executable, arguments: arguments_, ...options });

export const parseCommand = (
  input: unknown,
  registry: ResourceRegistry,
  path: string,
): DefinitionCommand => {
  const value = parseObject(input, path, ["executable", "arguments", "workingDirectory"]);
  const executableInput = required(value, "executable", path);
  const executable = typeof executableInput === "string"
    ? parseString(executableInput, `${path}.executable`, { maxLength: 256 })
    : {
        scriptId: (
          Object.hasOwn(executableInput as object, "scriptId")
            ? parseRegisteredReference(
                executableInput,
                "script",
                registry.scripts,
                `${path}.executable`,
              )
            : parseScriptReference(executableInput, registry, `${path}.executable`)
        ).id,
      };
  const workingDirectory = value.workingDirectory;
  return {
    executable,
    arguments: parseArray(
      required(value, "arguments", path),
      `${path}.arguments`,
      (argument, argumentPath) =>
        parseString(argument, argumentPath, {
          minLength: 0,
          maxLength: MAX_COMMAND_ARGUMENT_LENGTH,
        }),
      { maxLength: 256 },
    ),
    ...(workingDirectory === undefined
      ? {}
      : {
          workingDirectory: parseTargetLocation(
            workingDirectory,
            `${path}.workingDirectory`,
          ),
        }),
  };
};

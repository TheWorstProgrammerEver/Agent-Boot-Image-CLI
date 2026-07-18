import { command, parseCommand, type CommandInput, type DefinitionCommand } from "./command.js";
import type { ResourceRegistry } from "./resources.js";
import { fail, parseIdentifier, parseObject, required } from "./validation.js";

export interface ProviderInput {
  readonly id: string;
  readonly command: CommandInput;
  readonly promptTransport: "stdin";
}

export interface ProviderDefinition {
  id: string;
  command: DefinitionCommand;
  promptTransport: "stdin";
}

export const provider = (id: string, providerCommand: CommandInput): ProviderInput => ({
  id,
  command: providerCommand,
  promptTransport: "stdin",
});

export const executableProvider = (
  id: string,
  executable: string,
  arguments_: readonly string[] = [],
): ProviderInput => provider(id, command(executable, arguments_));

export const parseProvider = (
  input: unknown,
  registry: ResourceRegistry,
  path: string,
): ProviderDefinition => {
  const value = parseObject(input, path, ["id", "command", "promptTransport"]);
  const promptTransport = required(value, "promptTransport", path);
  if (promptTransport !== "stdin") {
    fail(`${path}.promptTransport`, 'Expected "stdin".');
  }
  return {
    id: parseIdentifier(required(value, "id", path), `${path}.id`),
    command: parseCommand(required(value, "command", path), registry, `${path}.command`),
    promptTransport,
  };
};

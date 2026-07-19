import type {
  AgentDefinition,
  DefinitionCommand,
  SequenceStep,
} from "@agent-boot/definition";
import {
  SCHEMA_VERSION,
  type CommandDescriptor,
  type RunnerPlan,
  type RunnerStep,
} from "@agent-boot/protocol";

const commandDescriptor = (command: DefinitionCommand): CommandDescriptor => ({
  executable: typeof command.executable === "string"
    ? command.executable
    : `/opt/agent-boot/scripts/${command.executable.scriptId}`,
  arguments: command.arguments,
  ...(command.workingDirectory === undefined
    ? {}
    : { workingDirectory: command.workingDirectory }),
});

const runnerStep = (step: SequenceStep): RunnerStep => {
  switch (step.kind) {
    case "automatic":
      return { ...step, command: commandDescriptor(step.command) };
    case "manual":
      return {
        ...step,
        command: commandDescriptor(step.command),
        completionCheck: commandDescriptor(step.completionCheck),
      };
    case "fire-and-forget":
      return { ...step, command: commandDescriptor(step.command) };
    default:
      return step;
  }
};

export const createRunnerPlan = (definition: AgentDefinition): RunnerPlan => ({
  schemaVersion: SCHEMA_VERSION,
  agentId: definition.agent.id,
  providers: definition.providers.map((provider) => ({
    id: provider.id,
    command: commandDescriptor(provider.command),
    promptTransport: provider.promptTransport,
  })),
  steps: definition.steps.map(runnerStep),
});

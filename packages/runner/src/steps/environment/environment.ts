import { isAbsolute, resolve } from "node:path";

import type {
  CommandDescriptor,
  EnvironmentStep,
  RunnerStep,
} from "@agent-boot/protocol";

import { RunnerConfigurationError } from "../../engine/errors.js";
import type { RunnerEnvironmentOptions } from "../../engine/model.js";

export type ChildEnvironment = Readonly<Record<string, string | undefined>>;

const requireAbsolutePath = (field: string, value: string): string => {
  if (!isAbsolute(value) || value.includes("\0")) {
    throw new RunnerConfigurationError(field, "expected an absolute path without null bytes");
  }
  return value;
};

const requireBasePath = (value: string): string => {
  if (value.length === 0 || value.includes("\0")) {
    throw new RunnerConfigurationError("basePath", "expected a non-empty value without null bytes");
  }
  return value;
};

export class RunnerEnvironment {
  readonly #base: ChildEnvironment;
  readonly #homeDirectory: string;
  readonly #workingDirectory: string;

  constructor(options: RunnerEnvironmentOptions) {
    this.#homeDirectory = requireAbsolutePath("homeDirectory", options.homeDirectory);
    this.#workingDirectory = requireAbsolutePath("workingDirectory", options.workingDirectory);
    this.#base = Object.freeze({
      HOME: this.#homeDirectory,
      PATH: requireBasePath(options.basePath),
    });
  }

  forStep(steps: readonly RunnerStep[], stepIndex: number): ChildEnvironment {
    const environment: Record<string, string | undefined> = { ...this.#base };
    for (const step of steps.slice(0, stepIndex)) {
      if (step.kind === "environment") applyEnvironmentStep(environment, step);
    }
    return Object.freeze(environment);
  }

  workingDirectoryFor(command: CommandDescriptor): string {
    const location = command.workingDirectory;
    if (location === undefined) return this.#workingDirectory;
    return location.scope === "user-home"
      ? resolve(this.#homeDirectory, location.path)
      : resolve("/", location.path);
  }
}

export const applyEnvironmentStep = (
  environment: Record<string, string | undefined>,
  step: EnvironmentStep,
): void => {
  environment[step.key] = step.operation === "set" ? step.value : undefined;
};

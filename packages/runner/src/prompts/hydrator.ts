import type { PromptStep } from "@agent-boot/protocol";

import type { ChildEnvironment } from "../steps/environment/index.js";
import type { AssemblyResourceResolver } from "./assembly-resolver.js";
import { PromptHydrationError } from "./errors.js";
import type { EphemeralPromptStore } from "./ephemeral-store.js";
import { renderTemplate } from "./template.js";

export interface SecretResolver {
  resolve(secretId: string): Promise<string | Uint8Array>;
}

export interface HydratedPrompt {
  readonly contents: Uint8Array;
  readonly renderedPromptId: string;
}

const decode = (contents: Uint8Array, resourceId: string): string => {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(contents);
  } catch {
    throw new PromptHydrationError("invalid-resource", resourceId);
  }
};

export class PromptHydrator {
  readonly #resources: AssemblyResourceResolver;
  readonly #secrets: SecretResolver;
  readonly #store: EphemeralPromptStore;

  constructor(
    resources: AssemblyResourceResolver,
    secrets: SecretResolver,
    store: EphemeralPromptStore,
  ) {
    this.#resources = resources;
    this.#secrets = secrets;
    this.#store = store;
  }

  async hydrate(step: PromptStep, environment: ChildEnvironment): Promise<HydratedPrompt> {
    const { contents, descriptor } = await this.#resources.resolvePrompt(step.templateId);
    const declared = new Set(descriptor.variables);
    const substitutions = new Map<string, string>();
    for (const binding of step.variables) {
      if (!declared.has(binding.name)) {
        throw new PromptHydrationError("missing-substitution", step.templateId);
      }
      if (binding.source.kind === "environment") {
        const value = environment[binding.source.key];
        if (value === undefined) {
          throw new PromptHydrationError("missing-substitution", step.templateId);
        }
        substitutions.set(binding.name, value);
        continue;
      }
      try {
        const value = await this.#secrets.resolve(binding.source.secretId);
        substitutions.set(
          binding.name,
          typeof value === "string" ? value : decode(value, step.templateId),
        );
      } catch (error) {
        if (error instanceof PromptHydrationError) throw error;
        throw new PromptHydrationError("missing-substitution", step.templateId);
      }
    }
    if (substitutions.size !== declared.size) {
      throw new PromptHydrationError("missing-substitution", step.templateId);
    }
    const rendered = new TextEncoder().encode(
      renderTemplate(decode(contents, step.templateId), substitutions, step.templateId),
    );
    await this.#store.write(step.renderedPromptId, rendered);
    return { contents: rendered, renderedPromptId: step.renderedPromptId };
  }

  remove(renderedPromptId: string): Promise<void> {
    return this.#store.remove(renderedPromptId);
  }

  removeAll(): Promise<void> {
    return this.#store.removeAll();
  }
}

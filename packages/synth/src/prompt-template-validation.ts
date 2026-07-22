import { TextDecoder } from "node:util";

import type { PromptDefinition } from "@agent-boot/definition";

import { SynthesisError } from "./errors.js";

const identifier = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/u;

const decodePrompt = (contents: Uint8Array, prompt: PromptDefinition, fieldPath: string): string => {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(contents);
  } catch {
    throw new SynthesisError(
      "invalid-input",
      `Prompt ${JSON.stringify(prompt.id)} must be valid UTF-8.`,
      fieldPath,
    );
  }
};

export const validatePromptTemplateVariables = (
  prompt: PromptDefinition,
  contents: Uint8Array,
  fieldPath: string,
): void => {
  const template = decodePrompt(contents, prompt, fieldPath);
  const declared = new Set(prompt.variables);
  const used = new Set<string>();
  const token = /\{\{([^{}]+)\}\}/gu;
  let cursor = 0;
  let match: RegExpExecArray | null;

  while ((match = token.exec(template)) !== null) {
    const before = template.slice(cursor, match.index);
    if (before.includes("{{") || before.includes("}}")) {
      throw new SynthesisError(
        "invalid-input",
        `Prompt ${JSON.stringify(prompt.id)} contains malformed template syntax.`,
        fieldPath,
      );
    }
    const name = match[1] ?? "";
    if (!identifier.test(name)) {
      throw new SynthesisError(
        "invalid-input",
        `Prompt ${JSON.stringify(prompt.id)} contains invalid variable ${JSON.stringify(name)}.`,
        fieldPath,
      );
    }
    if (!declared.has(name)) {
      throw new SynthesisError(
        "invalid-input",
        `Prompt ${JSON.stringify(prompt.id)} uses undeclared variable ${JSON.stringify(name)}.`,
        fieldPath,
      );
    }
    used.add(name);
    cursor = match.index + match[0].length;
  }

  const remainder = template.slice(cursor);
  if (remainder.includes("{{") || remainder.includes("}}")) {
    throw new SynthesisError(
      "invalid-input",
      `Prompt ${JSON.stringify(prompt.id)} contains malformed template syntax.`,
      fieldPath,
    );
  }
  for (const name of declared) {
    if (!used.has(name)) {
      throw new SynthesisError(
        "invalid-input",
        `Prompt ${JSON.stringify(prompt.id)} declares unused variable ${JSON.stringify(name)}.`,
        fieldPath,
      );
    }
  }
};

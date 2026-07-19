import { PromptHydrationError } from "./errors.js";

const identifier = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/u;
const token = /\{\{([^{}]+)\}\}/gu;

export const renderTemplate = (
  template: string,
  substitutions: ReadonlyMap<string, string>,
  templateId?: string,
): string => {
  let cursor = 0;
  let rendered = "";
  let match: RegExpExecArray | null;
  const used = new Set<string>();

  while ((match = token.exec(template)) !== null) {
    const before = template.slice(cursor, match.index);
    if (before.includes("{{") || before.includes("}}")) {
      throw new PromptHydrationError("missing-substitution", templateId);
    }
    const name = match[1] ?? "";
    const value = substitutions.get(name);
    if (!identifier.test(name) || value === undefined) {
      throw new PromptHydrationError("missing-substitution", templateId);
    }
    rendered += before + value;
    used.add(name);
    cursor = match.index + match[0].length;
  }

  const remainder = template.slice(cursor);
  if (remainder.includes("{{") || remainder.includes("}}")) {
    throw new PromptHydrationError("missing-substitution", templateId);
  }
  for (const name of substitutions.keys()) {
    if (!used.has(name)) throw new PromptHydrationError("missing-substitution", templateId);
  }
  return rendered + remainder;
};

import {
  PUBLIC_ENVIRONMENT_KEYS,
  type PublicEnvironmentKey,
  type TargetLocation,
} from "@agent-boot/protocol";

export class DefinitionValidationError extends Error {
  readonly path: string;

  constructor(path: string, reason: string) {
    super(`Agent definition validation failed at ${path}: ${reason}`);
    this.name = "DefinitionValidationError";
    this.path = path;
  }
}

export function fail(path: string, reason: string): never {
  throw new DefinitionValidationError(path, reason);
}

export const parseObject = (
  input: unknown,
  path: string,
  allowedFields: readonly string[],
): Record<string, unknown> => {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    fail(path, "Expected an object.");
  }
  const value = input as Record<string, unknown>;
  const allowed = new Set(allowedFields);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail(`${path}.${key}`, `Unknown field ${JSON.stringify(key)}.`);
  }
  return value;
};

export const required = (
  value: Record<string, unknown>,
  key: string,
  path: string,
): unknown => {
  if (!Object.hasOwn(value, key)) fail(`${path}.${key}`, "Required field is missing.");
  return value[key];
};

export const parseString = (
  input: unknown,
  path: string,
  options: { minLength?: number; maxLength?: number } = {},
): string => {
  if (typeof input !== "string") fail(path, "Expected a string.");
  const minLength = options.minLength ?? 1;
  const maxLength = options.maxLength ?? 1024;
  if (input.length < minLength || input.length > maxLength) {
    fail(path, `Expected ${String(minLength)}-${String(maxLength)} characters.`);
  }
  if (input.includes("\0")) fail(path, "NUL characters are not permitted.");
  return input;
};

const parsePattern = (
  input: unknown,
  path: string,
  pattern: RegExp,
  description: string,
  maxLength: number,
): string => {
  const value = parseString(input, path, { maxLength });
  if (!pattern.test(value)) fail(path, `Expected ${description}.`);
  return value;
};

export const parseIdentifier = (input: unknown, path: string): string =>
  parsePattern(
    input,
    path,
    /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/u,
    "a lowercase identifier",
    64,
  );

export const parseUsername = (input: unknown, path: string): string =>
  parsePattern(
    input,
    path,
    /^[a-z_][a-z0-9_-]{0,31}$/u,
    "a portable Unix username",
    32,
  );

export const parseHostname = (input: unknown, path: string): string =>
  parsePattern(
    input,
    path,
    /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u,
    "a lowercase hostname label",
    63,
  );

export const parseEnvironmentKey = (
  input: unknown,
  path: string,
): PublicEnvironmentKey => {
  const key = parsePattern(
    input,
    path,
    /^[A-Za-z_][A-Za-z0-9_]*$/u,
    "a portable environment key",
    128,
  );
  if (!(PUBLIC_ENVIRONMENT_KEYS as readonly string[]).includes(key)) {
    fail(
      path,
      `Expected an explicitly permitted public environment key (${PUBLIC_ENVIRONMENT_KEYS.join(
        ", ",
      )}); credentials must use secret references.`,
    );
  }
  return key as PublicEnvironmentKey;
};

export const parseRelativePath = (input: unknown, path: string): string => {
  const value = parseString(input, path, { maxLength: 512 });
  const parts = value.split("/");
  if (
    value.startsWith("/") ||
    value.endsWith("/") ||
    value.includes("\\") ||
    parts.some((part) => part === "" || part === "." || part === "..")
  ) {
    fail(path, "Expected a normalized relative path without traversal.");
  }
  return value;
};

export const parseTargetLocation = (input: unknown, path: string): TargetLocation => {
  const value = parseObject(input, path, ["scope", "path"]);
  const scope = required(value, "scope", path);
  if (scope !== "system" && scope !== "user-home") {
    fail(`${path}.scope`, "Expected one of: system, user-home.");
  }
  return {
    scope,
    path: parseRelativePath(required(value, "path", path), `${path}.path`),
  };
};

export const parseArray = <T>(
  input: unknown,
  path: string,
  parser: (value: unknown, path: string) => T,
  options: { minLength?: number; maxLength?: number } = {},
): T[] => {
  if (!Array.isArray(input)) fail(path, "Expected an array.");
  const minLength = options.minLength ?? 0;
  const maxLength = options.maxLength ?? 10_000;
  if (input.length < minLength || input.length > maxLength) {
    fail(path, `Expected ${String(minLength)}-${String(maxLength)} items.`);
  }
  return Array.from(input, (value, index) => parser(value, `${path}[${String(index)}]`));
};

export const assertUnique = <T>(
  values: readonly T[],
  path: string,
  select: (value: T) => string,
): void => {
  const seen = new Set<string>();
  for (const value of values) {
    const key = select(value);
    if (seen.has(key)) fail(path, `Duplicate identifier ${JSON.stringify(key)}.`);
    seen.add(key);
  }
};

export const parsePositiveInteger = (
  input: unknown,
  path: string,
  maximum: number,
): number => {
  if (typeof input !== "number" || !Number.isSafeInteger(input)) {
    fail(path, "Expected a safe integer.");
  }
  if (input < 1 || input > maximum) {
    fail(path, `Expected a value between 1 and ${String(maximum)}.`);
  }
  return input;
};

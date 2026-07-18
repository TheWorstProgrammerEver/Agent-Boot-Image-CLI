export class ProtocolValidationError extends Error {
  readonly path: string;
  readonly schemaName: string;

  constructor(schemaName: string, path: string, reason: string) {
    super(`${schemaName} validation failed at ${path}: ${reason}`);
    this.name = "ProtocolValidationError";
    this.path = path;
    this.schemaName = schemaName;
  }
}

export interface RuntimeSchema<T> {
  readonly name: string;
  parse(input: unknown): T;
}

export type Parser<T> = (input: unknown, path: string) => T;

let activeSchemaName = "Agent Boot protocol";

export function fail(path: string, reason: string): never {
  throw new ProtocolValidationError(activeSchemaName, path, reason);
}

export const createRuntimeSchema = <T>(
  name: string,
  parser: Parser<T>,
): RuntimeSchema<T> => ({
  name,
  parse(input) {
    const previousSchemaName = activeSchemaName;
    activeSchemaName = name;
    try {
      return parser(input, "$");
    } finally {
      activeSchemaName = previousSchemaName;
    }
  },
});

const forbiddenCredentialFields = new Set([
  "apikey",
  "credential",
  "credentials",
  "passphrase",
  "password",
  "pem",
  "privatekey",
  "secret",
  "token",
]);

const normalizedFieldName = (key: string) =>
  key.replaceAll(/[-_]/g, "").toLowerCase();

export const parseObject = (
  input: unknown,
  path: string,
  allowedFields: readonly string[],
): Record<string, unknown> => {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    fail(path, "Expected an object.");
  }

  const record = input as Record<string, unknown>;
  const allowed = new Set(allowedFields);
  for (const key of Object.keys(record)) {
    if (allowed.has(key)) continue;
    const normalized = normalizedFieldName(key);
    if (forbiddenCredentialFields.has(normalized)) {
      fail(
        `${path}.${key}`,
        "Plaintext credential fields are not permitted; use a secretId reference.",
      );
    }
    fail(`${path}.${key}`, `Unknown field ${JSON.stringify(key)}.`);
  }
  return record;
};

export const required = (
  record: Record<string, unknown>,
  key: string,
  path: string,
): unknown => {
  if (!Object.hasOwn(record, key)) fail(`${path}.${key}`, "Required field is missing.");
  return record[key];
};

export const optional = (
  record: Record<string, unknown>,
  key: string,
): unknown => record[key];

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

export const parseLiteral = <T extends string | number>(
  input: unknown,
  path: string,
  expected: T,
): T => {
  if (input !== expected) fail(path, `Expected ${JSON.stringify(expected)}.`);
  return expected;
};

export const parseEnum = <T extends string>(
  input: unknown,
  path: string,
  values: readonly T[],
): T => {
  if (typeof input !== "string" || !values.includes(input as T)) {
    fail(path, `Expected one of: ${values.join(", ")}.`);
  }
  return input as T;
};

export const parseInteger = (
  input: unknown,
  path: string,
  options: { minimum?: number; maximum?: number } = {},
): number => {
  if (typeof input !== "number" || !Number.isSafeInteger(input)) {
    fail(path, "Expected a safe integer.");
  }
  if (options.minimum !== undefined && input < options.minimum) {
    fail(path, `Expected a value of at least ${String(options.minimum)}.`);
  }
  if (options.maximum !== undefined && input > options.maximum) {
    fail(path, `Expected a value no greater than ${String(options.maximum)}.`);
  }
  return input;
};

export const parseArray = <T>(
  input: unknown,
  path: string,
  parser: Parser<T>,
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

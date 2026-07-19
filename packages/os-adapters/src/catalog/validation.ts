import { OsCatalogValidationError } from "./errors.js";

export function fail(path: string, reason: string): never {
  throw new OsCatalogValidationError(path, reason);
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

export const parseString = (input: unknown, path: string, maxLength = 1_024): string => {
  if (typeof input !== "string") fail(path, "Expected a string.");
  if (input.length < 1 || input.length > maxLength) {
    fail(path, `Expected 1-${String(maxLength)} characters.`);
  }
  if (input.includes("\0")) fail(path, "NUL characters are not permitted.");
  return input;
};

export const parseIdentifier = (input: unknown, path: string): string => {
  const value = parseString(input, path, 128);
  if (!/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/u.test(value)) {
    fail(path, "Expected a lowercase identifier.");
  }
  return value;
};

export const parseIsoDate = (input: unknown, path: string): string => {
  const value = parseString(input, path, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) fail(path, "Expected an ISO calendar date.");
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== value) {
    fail(path, "Expected a valid ISO calendar date.");
  }
  return value;
};

export const parsePositiveInteger = (input: unknown, path: string): number => {
  if (typeof input !== "number" || !Number.isSafeInteger(input) || input < 1) {
    fail(path, "Expected a positive safe integer.");
  }
  return input;
};

export const parseSha256 = (input: unknown, path: string): string => {
  const value = parseString(input, path, 64);
  if (!/^[a-f0-9]{64}$/u.test(value)) fail(path, "Expected a lowercase SHA-256 digest.");
  return value;
};

export const parseHttpsUrl = (input: unknown, path: string): string => {
  const value = parseString(input, path, 2_048);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    fail(path, "Expected an absolute HTTPS URL.");
  }
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    fail(path, "Expected an absolute HTTPS URL without credentials, query, or fragment.");
  }
  return url.href;
};

export const parseArray = <T>(
  input: unknown,
  path: string,
  parser: (item: unknown, itemPath: string) => T,
  options: { minLength?: number; maxLength?: number } = {},
): T[] => {
  if (!Array.isArray(input)) fail(path, "Expected an array.");
  const minLength = options.minLength ?? 0;
  const maxLength = options.maxLength ?? 64;
  if (input.length < minLength || input.length > maxLength) {
    fail(path, `Expected ${String(minLength)}-${String(maxLength)} items.`);
  }
  return input.map((item, index) => parser(item, `${path}[${String(index)}]`));
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

export const deepFreeze = <T>(value: T): T => {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value)) deepFreeze(nested);
  return Object.freeze(value);
};

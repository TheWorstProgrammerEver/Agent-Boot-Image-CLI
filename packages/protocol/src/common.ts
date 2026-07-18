import {
  fail,
  optional,
  parseArray,
  parseEnum,
  parseObject,
  parseString,
  required,
  type Parser,
} from "./schema.js";

export const SCHEMA_VERSION = 1 as const;
export type SchemaVersion = typeof SCHEMA_VERSION;

export interface SecretReference {
  secretId: string;
}

export interface TargetLocation {
  scope: "system" | "user-home";
  path: string;
}

export interface CommandDescriptor {
  executable: string;
  arguments: string[];
  workingDirectory?: TargetLocation;
}

export const PUBLIC_ENVIRONMENT_KEYS = ["AGENT_NAME", "BOOTSTRAP_MODE"] as const;
export type PublicEnvironmentKey = (typeof PUBLIC_ENVIRONMENT_KEYS)[number];

const identifierPattern = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;
const environmentKeyPattern = /^[A-Za-z_][A-Za-z0-9_]*$/;
const usernamePattern = /^[a-z_][a-z0-9_-]{0,31}$/;
const hostnamePattern = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const publicEnvironmentKeys = new Set<string>(PUBLIC_ENVIRONMENT_KEYS);

const parsePattern = (
  input: unknown,
  path: string,
  pattern: RegExp,
  description: string,
  maxLength: number,
) => {
  const value = parseString(input, path, { maxLength });
  if (!pattern.test(value)) fail(path, `Expected ${description}.`);
  return value;
};

export const parseIdentifier = (input: unknown, path: string): string =>
  parsePattern(input, path, identifierPattern, "a lowercase identifier", 64);

export const parsePublicEnvironmentKey = (
  input: unknown,
  path: string,
): PublicEnvironmentKey => {
  const key = parsePattern(
    input,
    path,
    environmentKeyPattern,
    "a portable environment key",
    128,
  );
  if (!publicEnvironmentKeys.has(key)) {
    fail(
      path,
      `Expected an explicitly permitted public environment key (${PUBLIC_ENVIRONMENT_KEYS.join(
        ", ",
      )}); credential material must use secretId-backed descriptors.`,
    );
  }
  return key as PublicEnvironmentKey;
};

export const parseUsername = (input: unknown, path: string): string =>
  parsePattern(input, path, usernamePattern, "a portable Unix username", 32);

export const parseHostname = (input: unknown, path: string): string =>
  parsePattern(input, path, hostnamePattern, "a lowercase hostname label", 63);

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

export const parsePrefixedPath = (
  input: unknown,
  path: string,
  prefix: string,
): string => {
  const value = parseRelativePath(input, path);
  if (!value.startsWith(`${prefix}/`)) {
    fail(path, `Expected a path beneath ${JSON.stringify(`${prefix}/`)}.`);
  }
  return value;
};

export const parseSha256 = (input: unknown, path: string): string => {
  const value = parseString(input, path, { minLength: 64, maxLength: 64 });
  if (!/^[a-f0-9]{64}$/.test(value)) fail(path, "Expected a lowercase SHA-256 digest.");
  return value;
};

export const parseHttpsUrl = (input: unknown, path: string): string => {
  const value = parseString(input, path, { maxLength: 2048 });
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username !== "" || url.password !== "") {
      throw new Error("not credential-free HTTPS");
    }
  } catch {
    fail(path, "Expected an absolute HTTPS URL without embedded credentials.");
  }
  return value;
};

export const parseSecretReference: Parser<SecretReference> = (input, path) => {
  const value = parseObject(input, path, ["secretId"]);
  return { secretId: parseIdentifier(required(value, "secretId", path), `${path}.secretId`) };
};

export const parseTargetLocation: Parser<TargetLocation> = (input, path) => {
  const value = parseObject(input, path, ["scope", "path"]);
  return {
    scope: parseEnum(required(value, "scope", path), `${path}.scope`, [
      "system",
      "user-home",
    ]),
    path: parseRelativePath(required(value, "path", path), `${path}.path`),
  };
};

export const parseCommandDescriptor: Parser<CommandDescriptor> = (input, path) => {
  const value = parseObject(input, path, [
    "executable",
    "arguments",
    "workingDirectory",
  ]);
  const workingDirectory = optional(value, "workingDirectory");
  return {
    executable: parseString(required(value, "executable", path), `${path}.executable`, {
      maxLength: 256,
    }),
    arguments: parseArray(
      required(value, "arguments", path),
      `${path}.arguments`,
      (argument, argumentPath) => parseString(argument, argumentPath, { minLength: 0 }),
      { maxLength: 256 },
    ),
    ...(workingDirectory === undefined
      ? {}
      : { workingDirectory: parseTargetLocation(workingDirectory, `${path}.workingDirectory`) }),
  };
};

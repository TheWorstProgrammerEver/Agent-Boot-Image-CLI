import {
  fail,
  parseIdentifier,
  parseObject,
  parseString,
  required,
} from "./validation.js";

export type LocalReferenceKind = "asset" | "prompt" | "script" | "secret";

export interface LocalReferenceInput<K extends LocalReferenceKind> {
  readonly kind: K;
  readonly id: string;
  readonly source: string;
}

export interface LocalReference<K extends LocalReferenceKind> {
  kind: K;
  id: string;
  source: {
    kind: "local";
    url: string;
  };
}

const hasEncodedNul = (pathname: string): boolean => /%00/iu.test(pathname);

export const parseDefinitionUrl = (input: unknown, path: string): string => {
  const value = parseString(input, path, { maxLength: 4096 });
  try {
    const url = new URL(value);
    if (
      url.protocol !== "file:" ||
      url.hostname !== "" ||
      url.username !== "" ||
      url.password !== "" ||
      url.search !== "" ||
      url.hash !== "" ||
      url.pathname.endsWith("/") ||
      hasEncodedNul(url.pathname)
    ) {
      throw new Error("not a definition file URL");
    }
    return url.href;
  } catch {
    fail(path, "Expected an absolute file URL for the definition file.");
  }
};

const resolveSource = (input: unknown, definitionUrl: string, path: string): string => {
  if (typeof input === "object" && input !== null && !Array.isArray(input)) {
    const value = parseObject(input, path, ["kind", "url"]);
    if (required(value, "kind", path) !== "local") {
      fail(`${path}.kind`, 'Expected "local".');
    }
    const url = parseString(required(value, "url", path), `${path}.url`, {
      maxLength: 4096,
    });
    try {
      const parsed = new URL(url);
      if (
        parsed.protocol !== "file:" ||
        parsed.hostname !== "" ||
        parsed.search !== "" ||
        parsed.hash !== "" ||
        parsed.pathname.endsWith("/") ||
        /%2f|%5c/iu.test(parsed.pathname) ||
        hasEncodedNul(parsed.pathname)
      ) {
        throw new Error("not an opaque local reference");
      }
      return parsed.href;
    } catch {
      fail(`${path}.url`, "Expected an absolute file URL without query or fragment.");
    }
  }

  const source = parseString(input, path, { maxLength: 2048 });
  if (
    source.startsWith("/") ||
    source.startsWith("\\") ||
    /^[A-Za-z]:/u.test(source) ||
    /^[A-Za-z][A-Za-z0-9+.-]*:/u.test(source) ||
    source.includes("\\") ||
    source.includes("?") ||
    source.includes("#")
  ) {
    fail(path, "Expected a relative local path without a URL scheme, query, or fragment.");
  }
  const resolved = new URL(source, definitionUrl);
  if (
    resolved.pathname.endsWith("/") ||
    /%2f|%5c/iu.test(resolved.pathname) ||
    hasEncodedNul(resolved.pathname)
  ) {
    fail(path, "Expected a local file path, not a directory, encoded separator, or NUL.");
  }
  return resolved.href;
};

export const parseLocalReference = <K extends LocalReferenceKind>(
  input: unknown,
  expectedKind: K,
  definitionUrl: string,
  path: string,
): LocalReference<K> => {
  const value = parseObject(input, path, ["kind", "id", "source"]);
  if (required(value, "kind", path) !== expectedKind) {
    fail(`${path}.kind`, `Expected ${JSON.stringify(expectedKind)}.`);
  }
  return {
    kind: expectedKind,
    id: parseIdentifier(required(value, "id", path), `${path}.id`),
    source: {
      kind: "local",
      url: resolveSource(required(value, "source", path), definitionUrl, `${path}.source`),
    },
  };
};

export const localReference = <K extends LocalReferenceKind>(
  kind: K,
  id: string,
  source: string,
): LocalReferenceInput<K> => ({ kind, id, source });

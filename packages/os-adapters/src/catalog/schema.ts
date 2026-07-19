import {
  SCHEMA_VERSION,
  osLockSchema,
  ProtocolValidationError,
  type PartitionDescriptor,
} from "@agent-boot/protocol";

import {
  assertUnique,
  fail,
  parseArray,
  parseHttpsUrl,
  parseIdentifier,
  parseIsoDate,
  parseObject,
  parsePositiveInteger,
  parseSha256,
  parseString,
  required,
} from "./validation.js";

export interface OsCatalogEntry {
  readonly catalogId: string;
  readonly lockId: string;
  readonly publishedAt: string;
  readonly operatingSystem: {
    readonly family: string;
    readonly release: string;
    readonly variant: string;
    readonly architecture: string;
  };
  readonly artifact: {
    readonly identity: string;
    readonly url: string;
    readonly byteLength: number;
    readonly checksum: {
      readonly algorithm: "sha256";
      readonly digest: string;
      readonly sourceUrl: string;
    };
  };
  readonly supportedBoards: readonly string[];
  readonly partitions: readonly PartitionDescriptor[];
}

export interface RuntimeSchema<T> {
  parse(input: unknown): T;
}

const parsePartition = (input: unknown, path: string): PartitionDescriptor => {
  const value = parseObject(input, path, ["role", "filesystem", "label"]);
  return {
    role: parseIdentifier(required(value, "role", path), `${path}.role`),
    filesystem: parseIdentifier(required(value, "filesystem", path), `${path}.filesystem`),
    label: parseString(required(value, "label", path), `${path}.label`, 64),
  };
};

const parseEntry = (input: unknown, path: string): OsCatalogEntry => {
  const value = parseObject(input, path, [
    "catalogId", "lockId", "publishedAt", "operatingSystem", "artifact",
    "supportedBoards", "partitions",
  ]);
  const operatingSystem = parseObject(
    required(value, "operatingSystem", path),
    `${path}.operatingSystem`,
    ["family", "release", "variant", "architecture"],
  );
  const artifact = parseObject(required(value, "artifact", path), `${path}.artifact`, [
    "identity", "url", "byteLength", "checksum",
  ]);
  const checksum = parseObject(
    required(artifact, "checksum", `${path}.artifact`),
    `${path}.artifact.checksum`,
    ["algorithm", "digest", "sourceUrl"],
  );
  const algorithm = required(checksum, "algorithm", `${path}.artifact.checksum`);
  if (algorithm !== "sha256") fail(`${path}.artifact.checksum.algorithm`, "Expected sha256.");

  const entry: OsCatalogEntry = {
    catalogId: parseIdentifier(required(value, "catalogId", path), `${path}.catalogId`),
    lockId: parseIdentifier(required(value, "lockId", path), `${path}.lockId`),
    publishedAt: parseIsoDate(required(value, "publishedAt", path), `${path}.publishedAt`),
    operatingSystem: {
      family: parseIdentifier(
        required(operatingSystem, "family", `${path}.operatingSystem`),
        `${path}.operatingSystem.family`,
      ),
      release: parseIdentifier(
        required(operatingSystem, "release", `${path}.operatingSystem`),
        `${path}.operatingSystem.release`,
      ),
      variant: parseIdentifier(
        required(operatingSystem, "variant", `${path}.operatingSystem`),
        `${path}.operatingSystem.variant`,
      ),
      architecture: parseIdentifier(
        required(operatingSystem, "architecture", `${path}.operatingSystem`),
        `${path}.operatingSystem.architecture`,
      ),
    },
    artifact: {
      identity: parseString(required(artifact, "identity", `${path}.artifact`), `${path}.artifact.identity`, 255),
      url: parseHttpsUrl(required(artifact, "url", `${path}.artifact`), `${path}.artifact.url`),
      byteLength: parsePositiveInteger(
        required(artifact, "byteLength", `${path}.artifact`),
        `${path}.artifact.byteLength`,
      ),
      checksum: {
        algorithm,
        digest: parseSha256(
          required(checksum, "digest", `${path}.artifact.checksum`),
          `${path}.artifact.checksum.digest`,
        ),
        sourceUrl: parseHttpsUrl(
          required(checksum, "sourceUrl", `${path}.artifact.checksum`),
          `${path}.artifact.checksum.sourceUrl`,
        ),
      },
    },
    supportedBoards: parseArray(
      required(value, "supportedBoards", path),
      `${path}.supportedBoards`,
      parseIdentifier,
      { minLength: 1 },
    ),
    partitions: parseArray(
      required(value, "partitions", path),
      `${path}.partitions`,
      parsePartition,
      { minLength: 1 },
    ),
  };
  validateImmutableIdentity(entry, path);
  validateResolvedLock(entry, path);
  return entry;
};

const validateImmutableIdentity = (entry: OsCatalogEntry, path: string): void => {
  if (entry.lockId !== `${entry.catalogId}-${entry.publishedAt}`) {
    fail(`${path}.lockId`, "Expected the catalog ID suffixed by the pinned publication date.");
  }
  if (!entry.artifact.identity.startsWith(`${entry.publishedAt}-`)) {
    fail(`${path}.artifact.identity`, "Expected an artifact identity pinned to publishedAt.");
  }
  const artifactUrl = new URL(entry.artifact.url);
  if (artifactUrl.pathname.split("/").at(-1) !== entry.artifact.identity) {
    fail(`${path}.artifact.url`, "Expected the immutable artifact identity as the URL filename.");
  }
  if (/(?:^|\/)(?:latest|current|stable)(?:\/|$)/u.test(artifactUrl.pathname)) {
    fail(`${path}.artifact.url`, "Mutable artifact URL aliases are not permitted.");
  }
  if (entry.artifact.checksum.sourceUrl !== `${entry.artifact.url}.sha256`) {
    fail(`${path}.artifact.checksum.sourceUrl`, "Expected the checksum sidecar for the pinned artifact URL.");
  }
  assertUnique(entry.supportedBoards, `${path}.supportedBoards`, (board) => board);
  assertUnique(entry.partitions, `${path}.partitions`, (partition) => partition.role);
};

const validateResolvedLock = (entry: OsCatalogEntry, path: string): void => {
  try {
    osLockSchema.parse({
      schemaVersion: SCHEMA_VERSION,
      catalogId: entry.lockId,
      operatingSystem: { ...entry.operatingSystem, boards: entry.supportedBoards },
      artifact: {
        url: entry.artifact.url,
        sha256: entry.artifact.checksum.digest,
        byteLength: entry.artifact.byteLength,
      },
      partitions: entry.partitions,
    });
  } catch (error) {
    if (error instanceof ProtocolValidationError) {
      fail(`${path}${error.path.slice(1)}`, `Cannot produce a valid OS lock: ${error.message}`);
    }
    throw error;
  }
};

export const osCatalogEntrySchema: RuntimeSchema<OsCatalogEntry> = {
  parse: (input) => parseEntry(input, "$"),
};

export const osCatalogSchema: RuntimeSchema<OsCatalogEntry[]> = {
  parse: (input) => {
    const entries = parseArray(input, "$", parseEntry, { minLength: 1 });
    assertUnique(entries, "$", (entry) => entry.catalogId);
    assertUnique(entries, "$", (entry) => entry.lockId);
    return entries;
  },
};

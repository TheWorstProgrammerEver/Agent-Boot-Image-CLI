import {
  parseHttpsUrl,
  parseIdentifier,
  parseSha256,
  SCHEMA_VERSION,
  type SchemaVersion,
} from "./common.js";
import {
  assertUnique,
  createRuntimeSchema,
  parseArray,
  parseInteger,
  parseLiteral,
  parseObject,
  parseString,
  required,
  type Parser,
} from "./schema.js";

export interface PartitionDescriptor {
  role: string;
  filesystem: string;
  label: string;
}

export interface OsLock {
  schemaVersion: SchemaVersion;
  catalogId: string;
  operatingSystem: {
    family: string;
    release: string;
    variant: string;
    architecture: string;
    boards: string[];
  };
  artifact: {
    url: string;
    sha256: string;
    byteLength: number;
  };
  partitions: PartitionDescriptor[];
}

const parsePartition: Parser<PartitionDescriptor> = (input, path) => {
  const value = parseObject(input, path, ["role", "filesystem", "label"]);
  return {
    role: parseIdentifier(required(value, "role", path), `${path}.role`),
    filesystem: parseIdentifier(required(value, "filesystem", path), `${path}.filesystem`),
    label: parseString(required(value, "label", path), `${path}.label`, { maxLength: 64 }),
  };
};

const parseOsLock = (input: unknown, path: string): OsLock => {
  const value = parseObject(input, path, [
    "schemaVersion",
    "catalogId",
    "operatingSystem",
    "artifact",
    "partitions",
  ]);
  const operatingSystem = parseObject(
    required(value, "operatingSystem", path),
    `${path}.operatingSystem`,
    ["family", "release", "variant", "architecture", "boards"],
  );
  const artifact = parseObject(required(value, "artifact", path), `${path}.artifact`, [
    "url",
    "sha256",
    "byteLength",
  ]);
  const boards = parseArray(
    required(operatingSystem, "boards", `${path}.operatingSystem`),
    `${path}.operatingSystem.boards`,
    parseIdentifier,
    { minLength: 1, maxLength: 64 },
  );
  const partitions = parseArray(
    required(value, "partitions", path),
    `${path}.partitions`,
    parsePartition,
    { minLength: 1, maxLength: 64 },
  );
  assertUnique(boards, `${path}.operatingSystem.boards`, (board) => board);
  assertUnique(partitions, `${path}.partitions`, (partition) => partition.role);
  return {
    schemaVersion: parseLiteral(
      required(value, "schemaVersion", path),
      `${path}.schemaVersion`,
      SCHEMA_VERSION,
    ),
    catalogId: parseIdentifier(required(value, "catalogId", path), `${path}.catalogId`),
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
      boards,
    },
    artifact: {
      url: parseHttpsUrl(required(artifact, "url", `${path}.artifact`), `${path}.artifact.url`),
      sha256: parseSha256(
        required(artifact, "sha256", `${path}.artifact`),
        `${path}.artifact.sha256`,
      ),
      byteLength: parseInteger(
        required(artifact, "byteLength", `${path}.artifact`),
        `${path}.artifact.byteLength`,
        { minimum: 1 },
      ),
    },
    partitions,
  };
};

export const osLockSchema = createRuntimeSchema("os-lock.json", parseOsLock);

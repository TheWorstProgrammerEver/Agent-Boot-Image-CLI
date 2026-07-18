import { SCHEMA_VERSION } from "./common.js";

export class SchemaCompatibilityError extends Error {
  readonly consumer: string;
  readonly documentName: string;
  readonly receivedVersion: unknown;
  readonly supportedVersions: readonly number[];

  constructor(
    consumer: string,
    documentName: string,
    receivedVersion: unknown,
    supportedVersions: readonly number[],
  ) {
    const received = receivedVersion === undefined ? "missing" : JSON.stringify(receivedVersion);
    super(
      `${consumer} cannot consume ${documentName} schema version ${received}. ` +
        `Supported versions: ${supportedVersions.join(", ")}. ` +
        "Regenerate the assembly with a compatible CLI or update the consuming runner/CLI.",
    );
    this.name = "SchemaCompatibilityError";
    this.consumer = consumer;
    this.documentName = documentName;
    this.receivedVersion = receivedVersion;
    this.supportedVersions = supportedVersions;
  }
}

export const assertCompatibleSchemaVersion = (
  consumer: string,
  documentName: string,
  receivedVersion: unknown,
  supportedVersions: readonly number[] = [SCHEMA_VERSION],
): number => {
  if (
    !Number.isSafeInteger(receivedVersion) ||
    !supportedVersions.includes(receivedVersion as number)
  ) {
    throw new SchemaCompatibilityError(
      consumer,
      documentName,
      receivedVersion,
      supportedVersions,
    );
  }
  return receivedVersion as number;
};

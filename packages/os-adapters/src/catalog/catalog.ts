import { SCHEMA_VERSION, osLockSchema, type OsLock } from "@agent-boot/protocol";

import { OsCatalogResolutionError } from "./errors.js";
import {
  osCatalogSchema,
  type OsCatalogEntry,
} from "./schema.js";
import { parseOsCatalogSelection } from "./selection.js";
import { deepFreeze } from "./validation.js";

export interface OsCatalog {
  readonly entries: readonly OsCatalogEntry[];
  resolve(input: unknown): ImmutableOsLock;
}

type Immutable<T> = T extends (...arguments_: never[]) => unknown
  ? T
  : T extends readonly (infer Item)[]
    ? readonly Immutable<Item>[]
    : T extends object
      ? { readonly [Key in keyof T]: Immutable<T[Key]> }
      : T;

export type ImmutableOsLock = Immutable<OsLock>;

const createLock = (entry: OsCatalogEntry): ImmutableOsLock =>
  deepFreeze(osLockSchema.parse({
    schemaVersion: SCHEMA_VERSION,
    catalogId: entry.lockId,
    operatingSystem: {
      ...entry.operatingSystem,
      boards: [...entry.supportedBoards],
    },
    artifact: {
      url: entry.artifact.url,
      sha256: entry.artifact.checksum.digest,
      byteLength: entry.artifact.byteLength,
    },
    partitions: entry.partitions.map((partition) => ({ ...partition })),
  }));

export const createOsCatalog = (input: unknown): OsCatalog => {
  const entries = deepFreeze(osCatalogSchema.parse(input));
  const entriesById = new Map(entries.map((entry) => [entry.catalogId, entry]));

  return deepFreeze({
    entries,
    resolve(selectionInput: unknown): ImmutableOsLock {
      const selection = parseOsCatalogSelection(selectionInput);
      const entry = entriesById.get(selection.catalogId);
      if (entry === undefined) {
        throw new OsCatalogResolutionError(
          "unknown-catalog-id",
          "$.catalogId",
          `Unknown or uncurated catalog ID ${JSON.stringify(selection.catalogId)}.`,
        );
      }
      if (selection.architecture !== entry.operatingSystem.architecture) {
        throw new OsCatalogResolutionError(
          "incompatible-architecture",
          "$.architecture",
          `${JSON.stringify(selection.catalogId)} requires ${entry.operatingSystem.architecture}.`,
        );
      }
      const supportedBoards = new Set(entry.supportedBoards);
      const unsupportedBoard = selection.boards.find((board) => !supportedBoards.has(board));
      if (unsupportedBoard !== undefined) {
        throw new OsCatalogResolutionError(
          "unsupported-board",
          "$.boards",
          `${JSON.stringify(unsupportedBoard)} is not explicitly supported by ${JSON.stringify(selection.catalogId)}.`,
        );
      }
      return createLock(entry);
    },
  });
};

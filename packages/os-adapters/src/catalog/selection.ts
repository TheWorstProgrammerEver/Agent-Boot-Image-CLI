import {
  assertUnique,
  parseArray,
  parseIdentifier,
  parseObject,
  required,
} from "./validation.js";

export interface OsCatalogSelection {
  readonly catalogId: string;
  readonly architecture: string;
  readonly boards: readonly string[];
}

export const parseOsCatalogSelection = (input: unknown): OsCatalogSelection => {
  const value = parseObject(input, "$", ["catalogId", "architecture", "boards"]);
  const boards = parseArray(required(value, "boards", "$"), "$.boards", parseIdentifier, {
    minLength: 1,
  });
  assertUnique(boards, "$.boards", (board) => board);
  return {
    catalogId: parseIdentifier(required(value, "catalogId", "$"), "$.catalogId"),
    architecture: parseIdentifier(required(value, "architecture", "$"), "$.architecture"),
    boards,
  };
};

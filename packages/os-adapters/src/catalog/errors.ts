export class OsCatalogValidationError extends Error {
  readonly path: string;

  constructor(path: string, reason: string) {
    super(`OS catalog validation failed at ${path}: ${reason}`);
    this.name = "OsCatalogValidationError";
    this.path = path;
  }
}

export type OsCatalogResolutionErrorCode =
  | "unknown-catalog-id"
  | "incompatible-architecture"
  | "unsupported-board";

export class OsCatalogResolutionError extends Error {
  readonly code: OsCatalogResolutionErrorCode;
  readonly path: string;

  constructor(code: OsCatalogResolutionErrorCode, path: string, reason: string) {
    super(`OS catalog resolution failed at ${path}: ${reason}`);
    this.name = "OsCatalogResolutionError";
    this.code = code;
    this.path = path;
  }
}

export class InvalidDefinitionError extends Error {
  readonly definitionPath: string;
  readonly fieldPath: string | undefined;

  constructor(definitionPath: string, reason: string, fieldPath?: string) {
    super(reason);
    this.name = "InvalidDefinitionError";
    this.definitionPath = definitionPath;
    this.fieldPath = fieldPath;
  }
}

export class IncompatibleDefinitionError extends Error {
  readonly definitionPath: string;

  constructor(definitionPath: string) {
    super("The definition schema version is not supported by this CLI.");
    this.name = "IncompatibleDefinitionError";
    this.definitionPath = definitionPath;
  }
}

export class DefinitionLoaderError extends Error {
  readonly definitionPath: string;
  readonly location: string | undefined;

  constructor(definitionPath: string, location?: string) {
    super("The trusted definition module could not be loaded or evaluated.");
    this.name = "DefinitionLoaderError";
    this.definitionPath = definitionPath;
    this.location = location;
  }
}

export type SynthesisErrorKind = "invalid-input" | "unsafe-reference" | "operational";

export class SynthesisError extends Error {
  readonly kind: SynthesisErrorKind;
  readonly fieldPath: string | undefined;

  constructor(kind: SynthesisErrorKind, message: string, fieldPath?: string) {
    super(message);
    this.name = "SynthesisError";
    this.kind = kind;
    this.fieldPath = fieldPath;
  }
}

export type PromptFailureReason =
  | "cleanup-failed"
  | "invalid-resource"
  | "missing-resource"
  | "missing-substitution"
  | "unsafe-resource"
  | "write-failed";

export class PromptHydrationError extends Error {
  readonly reason: PromptFailureReason;
  readonly resourceId: string | undefined;

  constructor(reason: PromptFailureReason, resourceId?: string) {
    const resource = resourceId === undefined ? "" : ` for ${JSON.stringify(resourceId)}`;
    super(`Prompt hydration failed (${reason})${resource}.`);
    this.name = "PromptHydrationError";
    this.reason = reason;
    this.resourceId = resourceId;
  }
}

export type CodexBootstrapStage = "authentication" | "configuration" | "installation";

export class CodexBootstrapError extends Error {
  readonly stage: CodexBootstrapStage;

  constructor(stage: CodexBootstrapStage) {
    super(`Codex ${stage} gate failed`);
    this.name = "CodexBootstrapError";
    this.stage = stage;
  }
}

import type { RunnerProgress } from "@agent-boot/runner";

const field = (name: string, value: number | string | boolean | null | undefined): string =>
  value === undefined ? "" : ` ${name}=${JSON.stringify(value)}`;

export const formatRunnerProgress = (progress: RunnerProgress): string => {
  const base = `agent-boot: status=${progress.status}`;
  switch (progress.status) {
    case "runner-succeeded":
      return `${base}\n`;
    case "runner-failed":
      return `${base}${field("code", progress.diagnostic.code)}${field("recovery", progress.diagnostic.recovery)}\n`;
    case "manual-waiting":
      return `${base}${field("step", progress.stepId)}${field("resumed", progress.resumed)}\n`;
    case "manual-check-retry":
      return `${base}${field("step", progress.stepId)}${field("check", progress.check)}${field("delayMs", progress.delayMs)}\n`;
    case "manual-completed":
      return `${base}${field("step", progress.stepId)}${field("check", progress.check)}\n`;
    case "manual-terminal-failure":
      return `${base}${field("step", progress.stepId)}${field("code", progress.diagnostic.code)}\n`;
    case "secret-source-removed":
      return `${base}${field("step", progress.stepId)}${field("deletionAssurance", progress.deletionAssurance)}\n`;
    case "step-started":
    case "step-succeeded":
      return `${base}${field("step", progress.stepId)}${field("attempt", progress.attempt)}\n`;
    case "step-failed":
      return `${base}${field("step", progress.stepId)}${field("attempt", progress.attempt)}${field("code", progress.diagnostic.code)}\n`;
  }
};

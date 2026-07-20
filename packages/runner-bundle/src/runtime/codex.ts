import { join } from "node:path";

import type { CommandHost } from "@agent-boot/process";
import type { RunnerPlan } from "@agent-boot/protocol";
import {
  CodexBootstrapGate,
  CodexProviderAdapter,
  NodeCodexProfileStore,
} from "@agent-boot/runner";

const sameArguments = (actual: readonly string[] | undefined, expected: readonly string[]): boolean =>
  (actual ?? []).join("\0") === expected.join("\0");

const beforeFirstProvider = (plan: RunnerPlan) => {
  const index = plan.steps.findIndex(step => step.kind === "provider");
  return index < 0 ? [] : plan.steps.slice(0, index);
};

const codexVersion = (plan: RunnerPlan): string => {
  for (const step of beforeFirstProvider(plan)) {
    if (
      step.kind === "automatic" &&
      step.command.executable === "agent-boot-codex" &&
      step.command.arguments[0] === "verify-version" &&
      step.command.arguments[1] === "--expected" &&
      step.command.arguments[2] !== undefined
    ) return step.command.arguments[2];
  }
  throw new Error("Codex provider is missing its pinned version gate.");
};

const codexAuthentication = (plan: RunnerPlan) => {
  for (const step of beforeFirstProvider(plan)) {
    if (
      step.kind === "manual" &&
      step.command.executable === "codex" &&
      sameArguments(step.command.arguments, ["login", "--device-auth"]) &&
      step.completionCheck.executable === "codex" &&
      sameArguments(step.completionCheck.arguments, ["login", "status"])
    ) {
      return {
        kind: "manual-device-auth" as const,
        pollIntervalSeconds: step.pollIntervalSeconds,
      };
    }
  }
  const hasAutomaticGate = beforeFirstProvider(plan).some(step =>
    step.kind === "automatic" &&
    step.command.executable === "codex" &&
    sameArguments(step.command.arguments, ["login", "status"]));
  if (hasAutomaticGate) return { kind: "automatic-credentials" as const };
  throw new Error("Codex provider is missing its authentication gate.");
};

export const createCodexProviderAdapter = (options: {
  readonly commandHost: CommandHost;
  readonly gid: number;
  readonly homeDirectory: string;
  readonly plan: RunnerPlan;
  readonly uid: number;
}): CodexProviderAdapter | undefined => {
  const providerSteps = options.plan.steps.filter(step => step.kind === "provider");
  if (providerSteps.length === 0) return undefined;
  if (options.plan.providers.some(provider => provider.command.executable !== "codex")) {
    throw new Error("Runner bundle supports only the verified Codex provider adapter.");
  }
  return new CodexProviderAdapter(new CodexBootstrapGate({
    authentication: codexAuthentication(options.plan),
    commandHost: options.commandHost,
    manualPolicy: {
      completionCheckTimeoutMs: 30_000,
      maximumPollIntervalMs: 30_000,
    },
    profileStore: new NodeCodexProfileStore({
      codexHome: join(options.homeDirectory, ".codex"),
      gid: options.gid,
      uid: options.uid,
    }),
    version: codexVersion(options.plan),
  }));
};

import { isAbsolute, join } from "node:path";

import { NodeSpawnAdapter } from "@agent-boot/process";

import { PromptJobOperationError, PromptJobValidationError } from "./errors.js";
import { loadScheduledPromptManifest } from "./manifest.js";
import {
  installPromptJobs,
  promptJobStatus,
  resolvePromptJobAccount,
  runLockedPromptJob,
  runOnce,
  runPromptJob,
  uninstallPromptJobs,
} from "./operations.js";
import { CommandSystemdControl } from "./systemd-control.js";

export interface PromptJobCommandIo {
  readonly stderr: (line: string) => void;
  readonly stdout: (line: string) => void;
}

const usage = [
  "Usage:",
  "  agent-boot-prompt-jobs validate --account NAME --manifest PATH",
  "  agent-boot-prompt-jobs install --account NAME --manifest PATH --enabled|--disabled",
  "  agent-boot-prompt-jobs status --account NAME --manifest PATH",
  "  agent-boot-prompt-jobs run-once --account NAME --manifest PATH --job ID",
  "  agent-boot-prompt-jobs canary --account NAME --manifest PATH --job ID",
  "  agent-boot-prompt-jobs uninstall --account NAME --manifest PATH",
].join("\n");

interface ParsedArguments {
  readonly account: string;
  readonly disabled: boolean;
  readonly enabled: boolean;
  readonly job?: string;
  readonly manifest: string;
  readonly operation: string;
}

const parseArguments = (arguments_: readonly string[]): ParsedArguments => {
  const operation = arguments_[0];
  if (operation === undefined) throw new PromptJobOperationError(usage);
  const values = new Map<string, string>();
  let enabled = false;
  let disabled = false;
  for (let index = 1; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--enabled") {
      enabled = true;
      continue;
    }
    if (argument === "--disabled") {
      disabled = true;
      continue;
    }
    if (argument !== "--account" && argument !== "--manifest" && argument !== "--job") {
      throw new PromptJobOperationError(usage);
    }
    const value = arguments_[index + 1];
    if (value === undefined || value.length === 0 || values.has(argument)) {
      throw new PromptJobOperationError(usage);
    }
    values.set(argument, value);
    index += 1;
  }
  const account = values.get("--account");
  const manifest = values.get("--manifest");
  const job = values.get("--job");
  if (account === undefined || manifest === undefined) throw new PromptJobOperationError(usage);
  return {
    account,
    disabled,
    enabled,
    ...(job === undefined ? {} : { job }),
    manifest,
    operation,
  };
};

const requiresRoot = new Set(["canary", "install", "run-once", "uninstall"]);

export const runPromptJobCommand = async (
  arguments_: readonly string[],
  io: PromptJobCommandIo,
): Promise<number> => {
  try {
    const parsed = parseArguments(arguments_);
    const account = await resolvePromptJobAccount(parsed.account);
    const manifestPath = isAbsolute(parsed.manifest)
      ? parsed.manifest
      : join(account.homeDirectory, parsed.manifest);
    const spawnHost = new NodeSpawnAdapter({ terminationGraceMs: 15_000 });
    const systemd = new CommandSystemdControl(spawnHost);
    const runtime = { account, manifestPath, spawnHost, systemd };
    if (requiresRoot.has(parsed.operation) && process.getuid?.() !== 0) {
      throw new PromptJobOperationError("This prompt-job operation requires root.");
    }
    if (
      (parsed.operation === "run" || parsed.operation === "run-locked") &&
      process.getuid?.() !== account.uid
    ) throw new PromptJobOperationError("The prompt job must run as its configured account.");

    switch (parsed.operation) {
      case "validate":
        await loadScheduledPromptManifest({
          accountUid: account.uid,
          calendarValidator: systemd,
          homeDirectory: account.homeDirectory,
          manifestPath,
        });
        io.stdout("scheduled-prompt-jobs: manifest=valid");
        return 0;
      case "install":
        if (parsed.enabled === parsed.disabled) throw new PromptJobOperationError(usage);
        await installPromptJobs(runtime, parsed.enabled);
        io.stdout(`scheduled-prompt-jobs: installed mode=${parsed.enabled ? "enabled" : "disabled"}`);
        return 0;
      case "status":
        io.stdout(JSON.stringify(await promptJobStatus(runtime)));
        return 0;
      case "run-once":
      case "canary": {
        if (parsed.job === undefined) throw new PromptJobOperationError(usage);
        io.stdout(JSON.stringify(await runOnce(runtime, parsed.job, parsed.operation === "canary")));
        return 0;
      }
      case "uninstall":
        await uninstallPromptJobs(runtime);
        io.stdout("scheduled-prompt-jobs: uninstalled");
        return 0;
      case "run":
        if (parsed.job === undefined) throw new PromptJobOperationError(usage);
        return await runPromptJob(runtime, parsed.job);
      case "run-locked":
        if (parsed.job === undefined) throw new PromptJobOperationError(usage);
        return await runLockedPromptJob(runtime, parsed.job);
      default:
        throw new PromptJobOperationError(usage);
    }
  } catch (error) {
    io.stderr(
      error instanceof PromptJobOperationError || error instanceof PromptJobValidationError
        ? error.message
        : "Scheduled prompt job operation failed.",
    );
    return 2;
  }
};

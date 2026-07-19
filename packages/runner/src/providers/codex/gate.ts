import type { CommandHost, SpawnResult } from "@agent-boot/process";
import type { ManualStep } from "@agent-boot/protocol";

import type { ManualStepPolicy, ManualStepScheduler } from "../../engine/model.js";
import { RunnerEnvironment } from "../../steps/environment/index.js";
import { ManualStepExecutor } from "../../steps/manual/index.js";
import type { ProviderPreparationInput } from "../adapter.js";
import { CodexBootstrapError } from "./errors.js";
import type { CodexProfileStore } from "./profile.js";
import { isExactCodexVersion, matchesCodexVersionOutput } from "./version.js";

export type CodexAuthentication =
  | { readonly kind: "automatic-credentials" }
  | {
      readonly kind: "manual-device-auth";
      readonly pollIntervalSeconds?: number;
    };

export interface CodexReadinessGate {
  ensureReady(input: ProviderPreparationInput): Promise<void>;
}

export interface CodexBootstrapGateOptions {
  readonly authentication: CodexAuthentication;
  readonly codexExecutable?: string;
  readonly commandHost: CommandHost;
  readonly installTimeoutMs?: number;
  readonly manualPolicy: ManualStepPolicy;
  readonly manualScheduler?: ManualStepScheduler;
  readonly npmExecutable?: string;
  readonly profileStore: CodexProfileStore;
  readonly version: string;
}

const succeeded = (result: SpawnResult): boolean =>
  result.reason === "exit" && result.exitCode === 0 && result.signal === null;

export class CodexBootstrapGate implements CodexReadinessGate {
  readonly #authentication: CodexAuthentication;
  readonly #codex: string;
  readonly #commandHost: CommandHost;
  readonly #installTimeoutMs: number;
  readonly #manualPolicy: ManualStepPolicy;
  readonly #manualScheduler: ManualStepScheduler | undefined;
  readonly #npm: string;
  readonly #profileStore: CodexProfileStore;
  readonly #version: string;

  constructor(options: CodexBootstrapGateOptions) {
    if (!isExactCodexVersion(options.version)) {
      throw new TypeError("Codex version must be an exact semver without a tag or range");
    }
    this.#authentication = options.authentication;
    this.#codex = options.codexExecutable ?? "codex";
    this.#commandHost = options.commandHost;
    this.#installTimeoutMs = options.installTimeoutMs ?? 10 * 60 * 1_000;
    this.#manualPolicy = options.manualPolicy;
    this.#manualScheduler = options.manualScheduler;
    this.#npm = options.npmExecutable ?? "npm";
    this.#profileStore = options.profileStore;
    this.#version = options.version;
  }

  async ensureReady(input: ProviderPreparationInput): Promise<void> {
    await this.#ensureInstallation(input);
    let configured: boolean;
    try {
      await this.#profileStore.ensure();
      configured = await this.#profileStore.verify();
    } catch {
      throw new CodexBootstrapError("configuration");
    }
    if (!configured) throw new CodexBootstrapError("configuration");
    await this.#ensureAuthentication(input);
  }

  async #ensureInstallation(input: ProviderPreparationInput): Promise<void> {
    if (await this.#hasExpectedVersion(input)) return;
    try {
      const result = await this.#commandHost.spawn({
        arguments: ["install", "--global", `@openai/codex@${this.#version}`],
        ...(input.cancellation === undefined ? {} : { cancellation: input.cancellation }),
        cwd: input.cwd,
        environment: this.#environment(input),
        executable: this.#npm,
        label: "install pinned Codex",
        lifetime: { policy: "managed" },
        stdio: "stream",
        timeoutMs: this.#installTimeoutMs,
      }).completion;
      if (!succeeded(result) || !(await this.#hasExpectedVersion(input))) {
        throw new Error("installation failed");
      }
    } catch {
      throw new CodexBootstrapError("installation");
    }
  }

  async #hasExpectedVersion(input: ProviderPreparationInput): Promise<boolean> {
    try {
      const result = await this.#commandHost.exec({
        arguments: ["--version"],
        cwd: input.cwd,
        environment: this.#environment(input),
        executable: this.#codex,
        label: "verify pinned Codex version",
        maxOutputBytes: 256,
        timeoutMs: 30_000,
      });
      return matchesCodexVersionOutput(result.stdout, this.#version);
    } catch {
      return false;
    }
  }

  async #ensureAuthentication(input: ProviderPreparationInput): Promise<void> {
    if (this.#authentication.kind === "automatic-credentials") {
      try {
        await this.#commandHost.exec({
          arguments: ["login", "status"],
          cwd: input.cwd,
          environment: this.#environment(input),
          executable: this.#codex,
          label: "verify Codex authentication",
          maxOutputBytes: 1_024,
          timeoutMs: this.#manualPolicy.completionCheckTimeoutMs,
        });
        return;
      } catch {
        throw new CodexBootstrapError("authentication");
      }
    }

    const homeDirectory = input.environment.HOME;
    const basePath = input.environment.PATH;
    if (homeDirectory === undefined || basePath === undefined) {
      throw new CodexBootstrapError("authentication");
    }
    const environment = new RunnerEnvironment({
      basePath,
      homeDirectory,
      workingDirectory: input.cwd,
    });
    const manual = new ManualStepExecutor(
      this.#commandHost,
      environment,
      this.#manualPolicy,
      this.#manualScheduler,
    );
    const step: ManualStep = {
      command: { arguments: ["login", "--device-auth"], executable: this.#codex },
      completionCheck: { arguments: ["login", "status"], executable: this.#codex },
      id: "codex-authenticate-device",
      kind: "manual",
      pollIntervalSeconds: this.#authentication.pollIntervalSeconds ?? 2,
    };
    const result = await manual.execute(
      step,
      this.#environment(input),
      true,
      input.cancellation,
    );
    if (result.status !== "succeeded") throw new CodexBootstrapError("authentication");
  }

  #environment(input: ProviderPreparationInput) {
    return { ...input.environment, CODEX_HOME: undefined };
  }
}

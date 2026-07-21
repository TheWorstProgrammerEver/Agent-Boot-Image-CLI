import type { TargetLocation } from "@agent-boot/protocol";

import { command } from "../command.js";
import type { ProviderInput } from "../provider.js";
import type { SecretInput } from "../resources.js";
import {
  automatic,
  installUserSecret,
  manual,
  type SequenceStepInput,
} from "../steps.js";

export const CODEX_BOOTSTRAP_EXECUTABLE = "agent-boot-codex";
export const CODEX_PACKAGE = "@openai/codex";
export const CODEX_PROFILE_NAME = "agent-boot";

export type CodexAuthenticationInput =
  | {
      readonly credential: SecretInput;
      readonly kind: "automatic-credentials";
    }
  | {
      readonly kind: "manual-device-auth";
      readonly pollIntervalSeconds?: number;
    };

export interface CodexProviderOptions {
  readonly authentication: CodexAuthenticationInput;
  readonly id?: string;
  readonly version: string;
  readonly workingRoot: TargetLocation;
}

export interface CodexProviderSlice {
  readonly bootstrapSteps: readonly SequenceStepInput[];
  readonly provider: ProviderInput;
}

const versionIdentifier = "(?:[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*|0|[1-9]\\d*)";
const exactVersionPattern = new RegExp(
  `^(?:0|[1-9]\\d*)\\.(?:0|[1-9]\\d*)\\.(?:0|[1-9]\\d*)(?:-${versionIdentifier}(?:\\.${versionIdentifier})*)?$`,
  "u",
);

const requireExactVersion = (version: string): string => {
  if (!exactVersionPattern.test(version)) {
    throw new TypeError("Codex version must be an exact semver without a tag or range");
  }
  return version;
};

const providerArguments = (): readonly string[] => [
  "--profile",
  CODEX_PROFILE_NAME,
  "--strict-config",
  "exec",
  "--skip-git-repo-check",
  "-",
];

export const codexProvider = (options: CodexProviderOptions): CodexProviderSlice => {
  const id = options.id ?? "codex";
  const version = requireExactVersion(options.version);
  const root = { workingDirectory: options.workingRoot } as const;
  const bootstrapSteps: SequenceStepInput[] = [
    automatic(
      `${id}-install`,
      command("npm", ["install", "--global", `${CODEX_PACKAGE}@${version}`], root),
    ),
    automatic(
      `${id}-verify-version`,
      command(CODEX_BOOTSTRAP_EXECUTABLE, ["verify-version", "--expected", version], root),
    ),
    automatic(
      `${id}-configure-profile`,
      command(CODEX_BOOTSTRAP_EXECUTABLE, ["configure-profile"], root),
    ),
    automatic(
      `${id}-verify-profile`,
      command(CODEX_BOOTSTRAP_EXECUTABLE, ["verify-profile"], root),
    ),
  ];

  if (options.authentication.kind === "automatic-credentials") {
    bootstrapSteps.push(
      installUserSecret(
        `${id}-install-credentials`,
        options.authentication.credential,
        ".codex/auth.json",
      ),
      automatic(
        `${id}-verify-authentication`,
        command("codex", ["login", "status"], root),
      ),
    );
  } else {
    bootstrapSteps.push(
      manual(
        `${id}-authenticate-device`,
        command("codex", ["login", "--device-auth"], root),
        command("codex", ["login", "status"], root),
        options.authentication.pollIntervalSeconds ?? 2,
      ),
    );
  }

  return {
    bootstrapSteps,
    provider: {
      id,
      command: command("codex", providerArguments(), root),
      promptTransport: "stdin",
    },
  };
};

import type { RunnerServiceAccount } from "./model.js";
import { TARGET_PATHS } from "./paths.js";

const accountName = /^[a-z_][a-z0-9_-]{0,31}$/u;
const safeAbsolutePath = /^\/(?:[A-Za-z0-9._-]+\/?)+$/u;

const assertAccount = (account: RunnerServiceAccount): void => {
  if (!accountName.test(account.username) || !accountName.test(account.group)) {
    throw new Error("Runner account and group must be safe systemd account names.");
  }
  for (const path of [account.homeDirectory, account.workingDirectory]) {
    if (!safeAbsolutePath.test(path)) {
      throw new Error("Runner home and working directories must be safe absolute paths.");
    }
  }
};

export class RunnerServiceContractError extends Error {
  readonly code = "incompatible-runner-service-contract" as const;

  constructor() {
    super("Runner bundle service contract is incompatible with the definition account.");
    this.name = "RunnerServiceContractError";
  }
}

const accountDirectives = (account: RunnerServiceAccount): readonly {
  readonly expected: string;
  readonly prefix: string;
}[] => {
  assertAccount(account);
  const npmPrefix = `${account.homeDirectory}/.local`;
  return [
    { expected: `User=${account.username}`, prefix: "User=" },
    { expected: `Group=${account.group}`, prefix: "Group=" },
    { expected: `Environment=HOME=${account.homeDirectory}`, prefix: "Environment=HOME=" },
    {
      expected: `Environment=NPM_CONFIG_PREFIX=${npmPrefix}`,
      prefix: "Environment=NPM_CONFIG_PREFIX=",
    },
    {
      expected: `Environment=AGENT_BOOT_WORKING_DIRECTORY=${account.workingDirectory}`,
      prefix: "Environment=AGENT_BOOT_WORKING_DIRECTORY=",
    },
    { expected: `WorkingDirectory=${account.workingDirectory}`, prefix: "WorkingDirectory=" },
  ];
};

export const verifyRunnerServiceContract = (
  contents: Uint8Array,
  account: RunnerServiceAccount,
): void => {
  const lines = Buffer.from(contents).toString("utf8").split("\n");
  for (const directive of accountDirectives(account)) {
    const matches = lines.filter((line) => line.startsWith(directive.prefix));
    if (matches.length !== 1 || matches[0] !== directive.expected) {
      throw new RunnerServiceContractError();
    }
  }
};

export const renderRunnerService = (account: RunnerServiceAccount): string => {
  assertAccount(account);
  const npmPrefix = `${account.homeDirectory}/.local`;
  const path = [
    `${npmPrefix}/bin`,
    `${TARGET_PATHS.scripts}/bin`,
    `${TARGET_PATHS.runtime}/bin`,
    "/usr/local/sbin",
    "/usr/local/bin",
    "/usr/sbin",
    "/usr/bin",
    "/sbin",
    "/bin",
  ].join(":");
  return [
    "[Unit]",
    "Description=Agent Boot private runner",
    "Wants=NetworkManager.service ssh.service",
    "After=local-fs.target userconfig.service NetworkManager.service ssh.service",
    "Conflicts=getty@tty1.service",
    "Before=getty@tty1.service",
    "StartLimitIntervalSec=0",
    "",
    "[Service]",
    "Type=exec",
    `User=${account.username}`,
    `Group=${account.group}`,
    `Environment=HOME=${account.homeDirectory}`,
    `Environment=NPM_CONFIG_PREFIX=${npmPrefix}`,
    `Environment=PATH=${path}`,
    `Environment=AGENT_BOOT_WORKING_DIRECTORY=${account.workingDirectory}`,
    `WorkingDirectory=${account.workingDirectory}`,
    `ExecStart=${TARGET_PATHS.scripts}/bin/agent-boot-runner`,
    "Restart=on-failure",
    "RestartSec=5s",
    "TimeoutStopSec=30s",
    "KillMode=mixed",
    "KillSignal=SIGTERM",
    "StateDirectory=agent-boot",
    "StateDirectoryMode=0700",
    "RuntimeDirectory=agent-boot",
    "RuntimeDirectoryMode=0700",
    "ConfigurationDirectory=agent-boot",
    "ConfigurationDirectoryMode=0750",
    "UMask=0077",
    `TTYPath=${TARGET_PATHS.tty}`,
    "StandardInput=tty-force",
    "StandardOutput=journal+console",
    "StandardError=journal+console",
    "TTYReset=yes",
    "TTYVHangup=yes",
    "TTYVTDisallocate=no",
    "SyslogIdentifier=agent-boot-runner",
    "",
    "[Install]",
    "WantedBy=multi-user.target",
    "",
  ].join("\n");
};

import type { RunnerServiceAccount } from "./model.js";
import { assertRunnerServiceAccount } from "./systemd.js";

export class RunnerServiceContractError extends Error {
  readonly code = "incompatible-runner-service-contract" as const;

  constructor() {
    super("Runner bundle service contract is incompatible with the definition account.");
    this.name = "RunnerServiceContractError";
  }
}

const parseUnitWords = (value: string): readonly string[] => {
  const words: string[] = [];
  let index = 0;
  while (index < value.length) {
    while (value[index] === " " || value[index] === "\t") index += 1;
    if (index === value.length) break;

    const quote = value[index] === "\"" || value[index] === "'" ? value[index] : undefined;
    if (quote !== undefined) index += 1;
    const start = index;
    while (
      index < value.length &&
      (quote === undefined
        ? value[index] !== " " && value[index] !== "\t"
        : value[index] !== quote)
    ) {
      if (value[index] === "\\" || (quote === undefined && /["']/u.test(value[index] ?? ""))) {
        throw new RunnerServiceContractError();
      }
      index += 1;
    }
    if (quote !== undefined && value[index] !== quote) throw new RunnerServiceContractError();
    words.push(value.slice(start, index));
    if (quote !== undefined) {
      index += 1;
      if (index < value.length && value[index] !== " " && value[index] !== "\t") {
        throw new RunnerServiceContractError();
      }
    }
  }
  return words;
};

const parseSingleUnitWord = (value: string): string => {
  const words = parseUnitWords(value);
  if (words.length !== 1) throw new RunnerServiceContractError();
  return words[0] ?? "";
};

const environmentName = /^[A-Za-z_][A-Za-z0-9_]*$/u;

const applyEnvironment = (environment: Map<string, string>, value: string): void => {
  const assignments = parseUnitWords(value);
  if (assignments.length === 0) environment.clear();
  for (const assignment of assignments) {
    const separator = assignment.indexOf("=");
    const name = assignment.slice(0, separator);
    if (separator < 1 || !environmentName.test(name)) throw new RunnerServiceContractError();
    environment.set(name, assignment.slice(separator + 1));
  }
};

const accountContract = (account: RunnerServiceAccount): ReadonlyMap<string, string> => {
  assertRunnerServiceAccount(account);
  return new Map([
    ["User", account.username],
    ["Group", account.group],
    ["HOME", account.homeDirectory],
    ["NPM_CONFIG_PREFIX", `${account.homeDirectory}/.local`],
    ["AGENT_BOOT_WORKING_DIRECTORY", account.workingDirectory],
    ["WorkingDirectory", account.workingDirectory],
  ]);
};

export const verifyRunnerServiceContract = (
  contents: Uint8Array,
  account: RunnerServiceAccount,
): void => {
  let unit: string;
  try {
    unit = new TextDecoder("utf-8", { fatal: true }).decode(contents);
  } catch {
    throw new RunnerServiceContractError();
  }
  if (unit.includes("\0")) throw new RunnerServiceContractError();

  const scalars = new Map<string, string>();
  const environment = new Map<string, string>();
  let environmentFiles: readonly string[] = [];
  let unsetEnvironment: readonly string[] = [];
  let section: string | undefined;
  for (const physicalLine of unit.split("\n")) {
    const line = physicalLine.trim();
    if (line === "" || line.startsWith("#") || line.startsWith(";")) continue;
    if (line.endsWith("\\")) throw new RunnerServiceContractError();
    if (line.startsWith("[")) {
      const match = /^\[([^\[\]]+)\]$/u.exec(line);
      if (match === null) throw new RunnerServiceContractError();
      section = match[1];
      continue;
    }
    if (section !== "Service") continue;

    const separator = line.indexOf("=");
    if (separator < 1) continue;
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    if (key === "User" || key === "Group" || key === "WorkingDirectory") {
      scalars.set(key, parseSingleUnitWord(value));
    } else if (key === "PAMName") {
      if (value === "") scalars.delete(key);
      else scalars.set(key, parseSingleUnitWord(value));
    } else if (key === "Environment") {
      applyEnvironment(environment, value);
    } else if (key === "EnvironmentFile") {
      const files = parseUnitWords(value);
      environmentFiles = files.length === 0 ? [] : [...environmentFiles, ...files];
    } else if (key === "UnsetEnvironment") {
      const assignments = parseUnitWords(value);
      unsetEnvironment = assignments.length === 0
        ? []
        : [...unsetEnvironment, ...assignments];
    }
  }

  if (environmentFiles.length > 0 || scalars.has("PAMName")) {
    throw new RunnerServiceContractError();
  }
  for (const assignment of unsetEnvironment) {
    const separator = assignment.indexOf("=");
    const name = separator === -1 ? assignment : assignment.slice(0, separator);
    if (!environmentName.test(name)) throw new RunnerServiceContractError();
    if (separator === -1 || environment.get(name) === assignment.slice(separator + 1)) {
      environment.delete(name);
    }
  }

  const actual = new Map([
    ["User", scalars.get("User")],
    ["Group", scalars.get("Group")],
    ["HOME", environment.get("HOME")],
    ["NPM_CONFIG_PREFIX", environment.get("NPM_CONFIG_PREFIX")],
    ["AGENT_BOOT_WORKING_DIRECTORY", environment.get("AGENT_BOOT_WORKING_DIRECTORY")],
    ["WorkingDirectory", scalars.get("WorkingDirectory")],
  ]);
  for (const [key, expected] of accountContract(account)) {
    if (actual.get(key) !== expected) throw new RunnerServiceContractError();
  }
};

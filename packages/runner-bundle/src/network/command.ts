import { NetworkCommandError } from "./errors.js";
import type { NetworkPrompter } from "./prompt.js";
import { TerminalNetworkPrompter } from "./prompt.js";
import { renderNetworkManagerProfile } from "./profile.js";
import { NetworkProfileStore } from "./profile-store.js";
import { SystemNetwork } from "./system-network.js";

interface ProfileWriter {
  write(contents: Uint8Array): Promise<void>;
}

interface NetworkOperations {
  apply(): Promise<void>;
  association(): Promise<"connected" | "unavailable">;
  restart(): Promise<void>;
}

export interface NetworkCommandDependencies {
  readonly effectiveUid?: () => number | undefined;
  readonly network?: NetworkOperations;
  readonly output?: (line: string) => void;
  readonly profileStore?: ProfileWriter;
  readonly prompter?: NetworkPrompter;
}

type ParsedCommand =
  | { readonly name: "configure" }
  | { readonly name: "restart" }
  | { readonly name: "set-wifi"; readonly ssid: string }
  | { readonly name: "status" };

const parseCommand = (arguments_: readonly string[]): ParsedCommand => {
  if (arguments_.length === 1 && arguments_[0] === "configure") return { name: "configure" };
  if (arguments_.length === 1 && arguments_[0] === "restart") return { name: "restart" };
  if (arguments_.length === 1 && arguments_[0] === "status") return { name: "status" };
  if (
    arguments_.length === 4 && arguments_[0] === "set-wifi" &&
    arguments_[1] === "--ssid" && arguments_[3] === "--ask-pass" &&
    arguments_[2] !== undefined
  ) return { name: "set-wifi", ssid: arguments_[2] };
  throw new NetworkCommandError("invalid-command");
};

const requireRoot = (effectiveUid: () => number | undefined): void => {
  if (effectiveUid() !== 0) throw new NetworkCommandError("root-required");
};

export const executeNetworkCommand = async (
  arguments_: readonly string[],
  dependencies: NetworkCommandDependencies = {},
): Promise<void> => {
  const command = parseCommand(arguments_);
  const effectiveUid = dependencies.effectiveUid ?? (() => process.geteuid?.());
  const network = dependencies.network ?? new SystemNetwork();
  const output = dependencies.output ?? (line => process.stdout.write(`${line}\n`));
  if (command.name === "status") {
    output(`agent-boot-network: association=${await network.association()}`);
    return;
  }

  requireRoot(effectiveUid);
  if (command.name === "restart") {
    await network.restart();
    output("agent-boot-network: network-restarted");
    return;
  }

  const prompter = dependencies.prompter ?? new TerminalNetworkPrompter();
  const profileStore = dependencies.profileStore ?? new NetworkProfileStore();
  const ssid = command.name === "configure" ? await prompter.ssid() : command.ssid;
  const passphrase = await prompter.passphrase();
  const profile = renderNetworkManagerProfile(ssid, passphrase);
  try {
    await profileStore.write(profile);
    await network.apply();
  } finally {
    profile.fill(0);
  }
  output("agent-boot-network: profile-updated-and-applied");
};

export const runNetworkCommand = async (arguments_: readonly string[]): Promise<void> => {
  try {
    await executeNetworkCommand(arguments_);
  } catch (error) {
    const code = error instanceof NetworkCommandError ? error.code : "apply-failed";
    process.stderr.write(`agent-boot-network: failed code=${code}\n`);
    process.exitCode = 1;
  }
};

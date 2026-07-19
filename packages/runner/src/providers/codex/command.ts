import { join } from "node:path";

import type { RunningCommand, SpawnHost } from "@agent-boot/process";

import { CodexBootstrapError } from "./errors.js";
import {
  NodeCodexProfileStore,
  type CodexProfileStore,
} from "./profile.js";
import { isExactCodexVersion, matchesCodexVersionOutput } from "./version.js";

export interface CodexBootstrapCommandRuntime {
  readonly profileStore: CodexProfileStore;
  readVersion(): Promise<string>;
}

const expectedVersion = (arguments_: readonly string[]): string => {
  if (
    arguments_.length !== 3 ||
    arguments_[1] !== "--expected" ||
    !isExactCodexVersion(arguments_[2] ?? "")
  ) {
    throw new CodexBootstrapError("installation");
  }
  return arguments_[2] as string;
};

export const runCodexBootstrapCommand = async (
  arguments_: readonly string[],
  runtime: CodexBootstrapCommandRuntime,
): Promise<void> => {
  const operation = arguments_[0];
  if (operation === "configure-profile" && arguments_.length === 1) {
    try {
      await runtime.profileStore.ensure();
    } catch {
      throw new CodexBootstrapError("configuration");
    }
    return;
  }
  if (operation === "verify-profile" && arguments_.length === 1) {
    try {
      if (await runtime.profileStore.verify()) return;
    } catch {
      throw new CodexBootstrapError("configuration");
    }
    throw new CodexBootstrapError("configuration");
  }
  if (operation === "verify-version") {
    const version = expectedVersion(arguments_);
    try {
      if (matchesCodexVersionOutput(await runtime.readVersion(), version)) return;
    } catch {
      throw new CodexBootstrapError("installation");
    }
    throw new CodexBootstrapError("installation");
  }
  throw new CodexBootstrapError("configuration");
};

export const createNodeCodexBootstrapCommandRuntime = (options: {
  readonly environment: NodeJS.ProcessEnv;
  readonly gid: number;
  readonly spawnHost: SpawnHost;
  readonly uid: number;
}): CodexBootstrapCommandRuntime => {
  const home = options.environment.HOME;
  if (home === undefined) throw new CodexBootstrapError("configuration");
  const codexHome = join(home, ".codex");
  return {
    profileStore: new NodeCodexProfileStore({ codexHome, gid: options.gid, uid: options.uid }),
    readVersion: async () => {
      const chunks: Uint8Array[] = [];
      let byteLength = 0;
      const control: { running?: RunningCommand } = {};
      const running = options.spawnHost.spawn({
        arguments: ["--version"],
        environment: { ...options.environment, CODEX_HOME: undefined },
        executable: "codex",
        label: "verify pinned Codex version",
        lifetime: { policy: "managed" },
        onOutput: (chunk) => {
          if (chunk.stream !== "stdout") return;
          byteLength += chunk.data.byteLength;
          if (byteLength > 256) control.running?.cancel();
          else chunks.push(chunk.data);
        },
        stdio: "stream",
        timeoutMs: 30_000,
      });
      control.running = running;
      const result = await running.completion;
      if (
        byteLength > 256 ||
        result.reason !== "exit" ||
        result.exitCode !== 0 ||
        result.signal !== null
      ) {
        throw new CodexBootstrapError("installation");
      }
      const contents = new Uint8Array(byteLength);
      let offset = 0;
      for (const chunk of chunks) {
        contents.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return new TextDecoder("utf-8", { fatal: true }).decode(contents);
    },
  };
};

import { spawn } from "node:child_process";

import { NetworkCommandError } from "./errors.js";

export interface CommandResult {
  readonly exitCode: number;
  readonly stdout: string;
}

export type NetworkCommandRunner = (
  executable: string,
  arguments_: readonly string[],
  timeoutMs: number,
) => Promise<CommandResult>;

export const runSystemCommand: NetworkCommandRunner = (executable, arguments_, timeoutMs) =>
  new Promise((resolve, reject) => {
    const child = spawn(executable, arguments_, {
      env: { PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" },
      stdio: ["ignore", "pipe", "ignore"],
    });
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (stdout.length < 256) stdout += chunk.slice(0, 256 - stdout.length);
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("System network command timed out."));
    }, timeoutMs);
    timer.unref();
    child.once("error", error => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", code => {
      clearTimeout(timer);
      resolve({ exitCode: code ?? 1, stdout });
    });
  });

const requireSuccess = async (
  run: NetworkCommandRunner,
  executable: string,
  arguments_: readonly string[],
  timeoutMs = 120_000,
): Promise<void> => {
  try {
    if ((await run(executable, arguments_, timeoutMs)).exitCode !== 0) {
      throw new NetworkCommandError("apply-failed");
    }
  } catch {
    throw new NetworkCommandError("apply-failed");
  }
};

export class SystemNetwork {
  constructor(private readonly run: NetworkCommandRunner = runSystemCommand) {}

  async association(): Promise<"connected" | "unavailable"> {
    try {
      const result = await this.run(
        "/usr/bin/nmcli",
        ["--get-values", "GENERAL.STATE", "device", "show", "wlan0"],
        5_000,
      );
      return result.exitCode === 0 && /^100(?:\s|$)/u.test(result.stdout.trim())
        ? "connected"
        : "unavailable";
    } catch {
      return "unavailable";
    }
  }

  async apply(): Promise<void> {
    await requireSuccess(this.run, "/usr/bin/nmcli", ["connection", "reload"]);
    await requireSuccess(
      this.run,
      "/usr/bin/nmcli",
      ["connection", "up", "id", "agent-boot-wifi", "ifname", "wlan0"],
    );
  }

  async restart(): Promise<void> {
    await requireSuccess(
      this.run,
      "/usr/bin/systemctl",
      ["restart", "NetworkManager.service"],
    );
    await this.apply();
  }
}

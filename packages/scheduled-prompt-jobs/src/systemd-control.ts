import type { SpawnHost } from "@agent-boot/process";

import type { CalendarValidator } from "./manifest.js";

export interface TimerState {
  readonly active: boolean;
  readonly enabled: boolean;
  readonly nextMonotonic: string;
  readonly nextRealtime: string;
}

export interface SystemdControl extends CalendarValidator {
  daemonReload(): Promise<void>;
  disableTimer(name: string): Promise<void>;
  enableTimer(name: string): Promise<void>;
  restartTimer(name: string): Promise<void>;
  startService(name: string): Promise<void>;
  timerState(name: string): Promise<TimerState>;
  verifyUnits(paths: readonly string[]): Promise<void>;
}

interface CommandResult {
  readonly exitCode: number | null;
  readonly stdout: string;
}

const run = async (
  spawnHost: SpawnHost,
  executable: string,
  arguments_: readonly string[],
  options: { allowFailure?: boolean; timeoutMs?: number } = {},
): Promise<CommandResult> => {
  const chunks: Uint8Array[] = [];
  let length = 0;
  const maximum = 64 * 1_024;
  const control: { overflow: boolean; running?: ReturnType<SpawnHost["spawn"]> } = {
    overflow: false,
  };
  const running = spawnHost.spawn({
    arguments: arguments_,
    environment: { LANG: "C.UTF-8", PATH: "/usr/sbin:/usr/bin:/sbin:/bin" },
    environmentMode: "replace",
    executable,
    label: `scheduled prompt systemd ${arguments_[0] ?? "operation"}`,
    lifetime: { policy: "managed" },
    onOutput: chunk => {
      if (chunk.stream !== "stdout" || control.overflow) return;
      length += chunk.data.byteLength;
      if (length > maximum) {
        control.overflow = true;
        control.running?.cancel();
      } else chunks.push(chunk.data);
    },
    stdio: "stream",
    timeoutMs: options.timeoutMs ?? 30_000,
  });
  control.running = running;
  const result = await running.completion;
  if (
    control.overflow || result.reason !== "exit" ||
    (options.allowFailure !== true && result.exitCode !== 0)
  ) throw new Error("Scheduled prompt systemd command failed.");
  const output = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return {
    exitCode: result.exitCode,
    stdout: new TextDecoder("utf-8", { fatal: true }).decode(output),
  };
};

const lines = (value: string): readonly string[] =>
  value.trim().split("\n").map(line => line.trim());

export class CommandSystemdControl implements SystemdControl {
  readonly #spawnHost: SpawnHost;

  constructor(spawnHost: SpawnHost) {
    this.#spawnHost = spawnHost;
  }

  async validate(expression: string): Promise<void> {
    await run(this.#spawnHost, "/usr/bin/systemd-analyze", ["calendar", "--", expression]);
  }

  async verifyUnits(paths: readonly string[]): Promise<void> {
    await run(this.#spawnHost, "/usr/bin/systemd-analyze", ["verify", ...paths]);
  }

  async daemonReload(): Promise<void> {
    await run(this.#spawnHost, "/usr/bin/systemctl", ["daemon-reload"]);
  }

  async disableTimer(name: string): Promise<void> {
    await run(this.#spawnHost, "/usr/bin/systemctl", ["disable", "--now", name], {
      allowFailure: true,
    });
  }

  async enableTimer(name: string): Promise<void> {
    await run(this.#spawnHost, "/usr/bin/systemctl", ["enable", name]);
  }

  async restartTimer(name: string): Promise<void> {
    await run(this.#spawnHost, "/usr/bin/systemctl", ["restart", name]);
  }

  async startService(name: string): Promise<void> {
    await run(this.#spawnHost, "/usr/bin/systemctl", ["start", name], {
      timeoutMs: 12 * 60 * 60 * 1_000,
    });
  }

  async timerState(name: string): Promise<TimerState> {
    const [enabled, active, nextRealtime, nextMonotonic] = await Promise.all([
      run(this.#spawnHost, "/usr/bin/systemctl", ["is-enabled", name], { allowFailure: true }),
      run(this.#spawnHost, "/usr/bin/systemctl", ["is-active", name], { allowFailure: true }),
      run(this.#spawnHost, "/usr/bin/systemctl", [
        "show",
        name,
        "--property=NextElapseUSecRealtime",
        "--value",
      ]),
      run(this.#spawnHost, "/usr/bin/systemctl", [
        "show",
        name,
        "--property=NextElapseUSecMonotonic",
        "--value",
      ]),
    ]);
    return {
      active: active.exitCode === 0,
      enabled: enabled.exitCode === 0,
      nextMonotonic: lines(nextMonotonic.stdout)[0] ?? "",
      nextRealtime: lines(nextRealtime.stdout)[0] ?? "",
    };
  }
}

const invalidNextValues = new Set(["", "0", "infinity", "n/a", "-"]);

export const hasFiniteNextTrigger = (state: TimerState): boolean =>
  [state.nextMonotonic, state.nextRealtime].some(value =>
    !invalidNextValues.has(value.trim().toLowerCase()));

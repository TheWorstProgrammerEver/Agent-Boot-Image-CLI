import type {
  BoundedExecCommand,
  BoundedExecResult,
  CommandHost,
  RunningCommand,
  SpawnCommand,
  SpawnHost,
} from "@agent-boot/process";

export class RuntimeCommandHost implements CommandHost {
  readonly #manualTerminalDescriptor: number;
  readonly #spawnHost: SpawnHost;

  constructor(spawnHost: SpawnHost, manualTerminalDescriptor: number) {
    this.#spawnHost = spawnHost;
    this.#manualTerminalDescriptor = manualTerminalDescriptor;
  }

  spawn(command: SpawnCommand): RunningCommand {
    return this.#spawnHost.spawn(command.stdio === "inherit"
      ? {
        ...command,
        stdio: { descriptor: this.#manualTerminalDescriptor, type: "terminal" },
      }
      : command);
  }

  async exec(command: BoundedExecCommand): Promise<BoundedExecResult> {
    const chunks: Uint8Array[] = [];
    const maximum = command.maxOutputBytes ?? 64 * 1_024;
    let length = 0;
    const control: { overflow: boolean; running?: RunningCommand } = { overflow: false };
    const running = this.#spawnHost.spawn({
      ...(command.arguments === undefined ? {} : { arguments: command.arguments }),
      ...(command.cwd === undefined ? {} : { cwd: command.cwd }),
      ...(command.environment === undefined ? {} : { environment: command.environment }),
      executable: command.executable,
      ...(command.label === undefined ? {} : { label: command.label }),
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
      ...(command.timeoutMs === undefined ? {} : { timeoutMs: command.timeoutMs }),
    });
    control.running = running;
    const result = await running.completion;
    if (
      control.overflow || result.reason !== "exit" ||
      result.exitCode !== 0 || result.signal !== null
    ) {
      throw new Error("Bounded command failed.");
    }
    const output = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      output.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return {
      exitCode: 0,
      signal: null,
      stderr: "",
      stdout: new TextDecoder("utf-8", { fatal: true }).decode(output),
    };
  }
}

import type {
  BoundedExecCommand,
  BoundedExecHost,
  BoundedExecResult,
  SpawnHost,
} from "@agent-boot/process";

export class SpawnBoundedExecHost implements BoundedExecHost {
  readonly #commands: SpawnHost;

  constructor(commands: SpawnHost) {
    this.#commands = commands;
  }

  async exec(command: BoundedExecCommand): Promise<BoundedExecResult> {
    const maximum = command.maxOutputBytes ?? 1_048_576;
    const stdout: Uint8Array[] = [];
    let byteLength = 0;
    let exceeded = false;
    const outputExceeded = (): boolean => exceeded;
    const running = this.#commands.spawn({
      ...command,
      lifetime: { policy: "managed" },
      onOutput: ({ data, stream }) => {
        if (stream !== "stdout" || exceeded) return;
        byteLength += data.byteLength;
        if (byteLength > maximum) {
          exceeded = true;
          running.cancel();
          return;
        }
        stdout.push(Uint8Array.from(data));
      },
      stdio: "stream",
    });
    const result = await running.completion;
    if (outputExceeded() || result.reason !== "exit" || result.exitCode !== 0) {
      throw new Error("bounded command failed");
    }
    return {
      exitCode: 0,
      signal: null,
      stderr: "",
      stdout: Buffer.concat(stdout).toString("utf8"),
    };
  }
}

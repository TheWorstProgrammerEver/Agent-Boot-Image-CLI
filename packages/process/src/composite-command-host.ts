import type {
  BoundedExecCommand,
  BoundedExecHost,
  BoundedExecResult,
  CommandHost,
  RunningCommand,
  SpawnCommand,
  SpawnHost,
} from './command.js';

export class CompositeCommandHost implements CommandHost {
  readonly #execHost: BoundedExecHost;
  readonly #spawnHost: SpawnHost;

  constructor(execHost: BoundedExecHost, spawnHost: SpawnHost) {
    this.#execHost = execHost;
    this.#spawnHost = spawnHost;
  }

  exec(command: BoundedExecCommand): Promise<BoundedExecResult> {
    return this.#execHost.exec(command);
  }

  spawn(command: SpawnCommand): RunningCommand {
    return this.#spawnHost.spawn(command);
  }
}

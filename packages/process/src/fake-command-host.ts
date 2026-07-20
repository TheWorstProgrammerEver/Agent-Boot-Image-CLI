import type {
  BoundedExecCommand,
  BoundedExecResult,
  CommandHost,
  RunningCommand,
  SpawnCommand,
  SpawnOutputChunk,
  SpawnResult,
} from './command.js';
import { FakeCommandScriptError } from './errors.js';

type Scripted<T> = { readonly result: T } | { readonly error: Error };

export interface FakeSpawnScript {
  readonly output?: readonly SpawnOutputChunk[];
  readonly result: SpawnResult;
}

const nextScript = <T>(scripts: Scripted<T>[], operation: 'exec' | 'spawn'): Scripted<T> => {
  const script = scripts.shift();
  if (script === undefined) throw new FakeCommandScriptError(operation);
  return script;
};

const cloneBytes = (data: Uint8Array): Uint8Array => Uint8Array.from(data);

const cloneExecCommand = (command: BoundedExecCommand): BoundedExecCommand => ({
  ...command,
  ...(command.arguments === undefined ? {} : { arguments: [...command.arguments] }),
  ...(command.environment === undefined ? {} : { environment: { ...command.environment } }),
  ...(command.sensitiveValues === undefined ? {} : { sensitiveValues: [...command.sensitiveValues] }),
});

const cloneSpawnCommand = (command: SpawnCommand): SpawnCommand => ({
  ...cloneExecCommand(command),
  ...(command.forwardSignals === undefined ? {} : { forwardSignals: [...command.forwardSignals] }),
  ...(command.stdin === undefined
    ? {}
    : { stdin: typeof command.stdin === 'string' ? command.stdin : cloneBytes(command.stdin) }),
  lifetime: { ...command.lifetime },
  stdio: typeof command.stdio === 'string' ? command.stdio : { ...command.stdio },
});

export class FakeCommandHost implements CommandHost {
  readonly execCalls: BoundedExecCommand[] = [];
  readonly spawnCalls: SpawnCommand[] = [];
  readonly #execScripts: Scripted<BoundedExecResult>[] = [];
  readonly #spawnScripts: Scripted<FakeSpawnScript>[] = [];

  scriptExecResult(result: BoundedExecResult): this {
    this.#execScripts.push({ result });
    return this;
  }

  scriptExecError(error: Error): this {
    this.#execScripts.push({ error });
    return this;
  }

  scriptSpawnResult(script: FakeSpawnScript): this {
    this.#spawnScripts.push({ result: script });
    return this;
  }

  scriptSpawnError(error: Error): this {
    this.#spawnScripts.push({ error });
    return this;
  }

  exec(command: BoundedExecCommand): Promise<BoundedExecResult> {
    this.execCalls.push(cloneExecCommand(command));
    let script: Scripted<BoundedExecResult>;
    try {
      script = nextScript(this.#execScripts, 'exec');
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error('Unknown fake exec failure'));
    }
    if ('error' in script) return Promise.reject(script.error);
    return Promise.resolve(script.result);
  }

  spawn(command: SpawnCommand): RunningCommand {
    this.spawnCalls.push(cloneSpawnCommand(command));
    const script = nextScript(this.#spawnScripts, 'spawn');
    const completion = Promise.resolve().then(() => {
      if ('error' in script) throw script.error;
      for (const chunk of script.result.output ?? []) {
        command.onOutput?.({ data: cloneBytes(chunk.data), stream: chunk.stream });
      }
      return script.result.result;
    });

    return {
      cancel: () => undefined,
      completion,
      pid: undefined,
      sendSignal: () => false,
    };
  }
}

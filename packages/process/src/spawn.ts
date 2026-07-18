import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { constants as osConstants } from 'node:os';

import type { RunningCommand, SpawnCommand, SpawnHost, SpawnResult } from './command.js';
import { validateCommand } from './command.js';
import { CommandStartError, reasonFromExit } from './errors.js';
import { processGroupExists, signalProcessGroup, terminateProcessGroup } from './process-group.js';
import { formatCommand, type Redactor } from './redaction.js';

export interface SignalSource {
  on(signal: NodeJS.Signals, listener: () => void): unknown;
  off(signal: NodeJS.Signals, listener: () => void): unknown;
}

export type SpawnProcess = (
  executable: string,
  arguments_: readonly string[],
  options: SpawnOptions,
) => ChildProcess;

export interface NodeSpawnAdapterOptions {
  readonly redactor?: Redactor;
  readonly signalSource?: SignalSource;
  readonly spawnProcess?: SpawnProcess;
  readonly terminationGraceMs?: number;
}

const stdioModes = new Set<unknown>(['inherit', 'stream']);
const lifetimePolicies = new Set<unknown>(['managed', 'detached']);

const validateSpawnCommand = (command: SpawnCommand): void => {
  validateCommand(command);
  if (!stdioModes.has(command.stdio)) {
    throw new TypeError('stdio must be inherit or stream');
  }
  if (!lifetimePolicies.has(command.lifetime.policy)) {
    throw new TypeError('lifetime policy must be managed or detached');
  }
  if (command.timeoutMs !== undefined &&
      (!Number.isSafeInteger(command.timeoutMs) || command.timeoutMs <= 0)) {
    throw new RangeError('timeoutMs must be a positive integer');
  }
  if (command.lifetime.policy === 'detached' && command.lifetime.unref && command.stdio === 'stream') {
    throw new TypeError('an unref detached command cannot use streamed stdio');
  }
  if (command.forwardSignals?.includes('SIGKILL') === true ||
      command.forwardSignals?.includes('SIGSTOP') === true) {
    throw new TypeError('SIGKILL and SIGSTOP cannot be forwarded from the parent process');
  }
  for (const signal of command.forwardSignals ?? []) {
    if (!(signal in osConstants.signals)) {
      throw new TypeError(`${signal} is not supported on this platform`);
    }
  }
};

const environmentFor = (overrides: SpawnCommand['environment']): NodeJS.ProcessEnv => {
  const entries = Object.entries(overrides ?? {});
  const removed = new Set(entries.filter(([, value]) => value === undefined).map(([name]) => name));
  const inherited = Object.entries(process.env).filter(([name]) => !removed.has(name));
  const defined = entries.filter((entry): entry is [string, string] => entry[1] !== undefined);
  return Object.fromEntries([...inherited, ...defined]);
};

const resolvedReason = (
  requested: 'canceled' | 'timeout' | undefined,
  exitCode: number | null,
  signal: NodeJS.Signals | null,
): SpawnResult['reason'] => requested ?? reasonFromExit(exitCode, signal);

const completedWithoutSpawn = (reason: 'canceled'): RunningCommand => ({
  cancel: () => undefined,
  completion: Promise.resolve({ exitCode: null, reason, signal: null }),
  pid: undefined,
  sendSignal: () => false,
});

const isCanceled = (signal: AbortSignal | undefined): boolean => signal?.aborted === true;

const errorCode = (error: unknown): string | undefined => {
  const code = (error as NodeJS.ErrnoException).code;
  return typeof code === 'string' ? code : undefined;
};

export class NodeSpawnAdapter implements SpawnHost {
  readonly #redactor: Redactor;
  readonly #signalSource: SignalSource;
  readonly #spawnProcess: SpawnProcess;
  readonly #terminationGraceMs: number;

  constructor(options: NodeSpawnAdapterOptions = {}) {
    this.#redactor = options.redactor ?? (value => value);
    this.#signalSource = options.signalSource ?? process;
    this.#spawnProcess = options.spawnProcess ?? nodeSpawn;
    const terminationGraceMs = options.terminationGraceMs ?? 100;
    if (!Number.isSafeInteger(terminationGraceMs) || terminationGraceMs <= 0) {
      throw new RangeError('terminationGraceMs must be a positive integer');
    }
    this.#terminationGraceMs = terminationGraceMs;
  }

  spawn(command: SpawnCommand): RunningCommand {
    validateSpawnCommand(command);
    if (process.platform === 'win32') {
      throw new Error('NodeSpawnAdapter requires a POSIX platform');
    }
    if (isCanceled(command.cancellation)) return completedWithoutSpawn('canceled');

    let child: ChildProcess;
    try {
      child = this.#spawnProcess(command.executable, command.arguments ?? [], {
        cwd: command.cwd,
        detached: true,
        env: environmentFor(command.environment),
        shell: false,
        stdio: command.stdio === 'inherit' ? 'inherit' : ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (error) {
      throw new CommandStartError(formatCommand(command, this.#redactor), errorCode(error));
    }

    if (command.lifetime.policy === 'detached' && command.lifetime.unref) child.unref();

    let requestedReason: 'canceled' | 'timeout' | undefined;
    let termination: Promise<void> | undefined;
    let settled = false;
    let timeout: NodeJS.Timeout | undefined;
    const signalListeners = new Map<NodeJS.Signals, () => void>();

    const beginTermination = (reason: 'canceled' | 'timeout', signal: NodeJS.Signals): void => {
      if (settled || requestedReason !== undefined) return;
      requestedReason = reason;
      if (timeout !== undefined) clearTimeout(timeout);
      termination = terminateProcessGroup(child, signal, this.#terminationGraceMs);
    };

    const cancel = (signal: NodeJS.Signals = 'SIGTERM'): void => {
      beginTermination('canceled', signal);
    };
    const abort = (): void => {
      cancel();
    };
    command.cancellation?.addEventListener('abort', abort, { once: true });
    if (isCanceled(command.cancellation)) abort();

    for (const signal of new Set(command.forwardSignals ?? [])) {
      const listener = (): void => {
        signalProcessGroup(child, signal);
      };
      signalListeners.set(signal, listener);
      this.#signalSource.on(signal, listener);
    }

    if (command.timeoutMs !== undefined) {
      timeout = setTimeout(() => {
        beginTermination('timeout', 'SIGTERM');
      }, command.timeoutMs);
    }

    if (command.stdio === 'stream') {
      child.stdout?.on('data', (data: Buffer) => {
        command.onOutput?.({ data, stream: 'stdout' });
      });
      child.stderr?.on('data', (data: Buffer) => {
        command.onOutput?.({ data, stream: 'stderr' });
      });
    }

    const cleanup = (): void => {
      if (timeout !== undefined) clearTimeout(timeout);
      command.cancellation?.removeEventListener('abort', abort);
      for (const [signal, listener] of signalListeners) this.#signalSource.off(signal, listener);
    };

    const completion = new Promise<SpawnResult>((resolve, reject) => {
      child.once('error', (error) => {
        settled = true;
        cleanup();
        reject(new CommandStartError(formatCommand(command, this.#redactor), errorCode(error)));
      });
      child.once('close', (exitCode, signal) => {
        if (settled) return;
        settled = true;
        const completionReason = requestedReason;
        cleanup();
        void (async () => {
          if (termination !== undefined) await termination;
          else if (command.lifetime.policy === 'managed' && processGroupExists(child)) {
            await terminateProcessGroup(child, 'SIGTERM', this.#terminationGraceMs);
          }
          resolve({ exitCode, reason: resolvedReason(completionReason, exitCode, signal), signal });
        })().catch(reject);
      });
    });

    return {
      cancel,
      completion,
      pid: child.pid,
      sendSignal: signal => settled ? false : signalProcessGroup(child, signal),
    };
  }
}

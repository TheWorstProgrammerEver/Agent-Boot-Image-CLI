export interface CommandDescriptor {
  readonly executable: string;
  readonly arguments?: readonly string[];
  readonly cwd?: string;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  /** Non-secret values that must be removed from diagnostics and log representations. */
  readonly sensitiveValues?: readonly string[];
  /** A short operation name. It is redacted before use in diagnostics. */
  readonly label?: string;
}

export interface BoundedExecCommand extends CommandDescriptor {
  readonly maxOutputBytes?: number;
  readonly timeoutMs?: number;
}

export interface BoundedExecResult {
  readonly exitCode: 0;
  readonly signal: null;
  readonly stderr: '';
  readonly stdout: string;
}

export type SpawnOutputStream = 'stderr' | 'stdout';

export interface SpawnOutputChunk {
  readonly data: Uint8Array;
  readonly stream: SpawnOutputStream;
}

export type SpawnLifetime =
  | { readonly policy: 'managed' }
  | { readonly policy: 'detached'; readonly unref: boolean };

export interface SpawnCommand extends CommandDescriptor {
  readonly cancellation?: AbortSignal;
  readonly forwardSignals?: readonly NodeJS.Signals[];
  /** Deliberate child stdin. It is never included in command representations or diagnostics. */
  readonly stdin?: string | Uint8Array;
  readonly lifetime: SpawnLifetime;
  readonly onOutput?: (chunk: SpawnOutputChunk) => void;
  readonly stdio: 'inherit' | 'stream';
  readonly timeoutMs?: number;
}

export type SpawnCompletionReason = 'canceled' | 'exit' | 'signal' | 'timeout';

export interface SpawnResult {
  readonly exitCode: number | null;
  readonly reason: SpawnCompletionReason;
  readonly signal: NodeJS.Signals | null;
}

export interface RunningCommand {
  readonly completion: Promise<SpawnResult>;
  readonly pid: number | undefined;
  cancel(signal?: NodeJS.Signals): void;
  sendSignal(signal: NodeJS.Signals): boolean;
}

export interface BoundedExecHost {
  exec(command: BoundedExecCommand): Promise<BoundedExecResult>;
}

export interface SpawnHost {
  spawn(command: SpawnCommand): RunningCommand;
}

export interface CommandHost extends BoundedExecHost, SpawnHost {}

const assertText = (name: string, value: string): void => {
  if (value.length === 0) throw new TypeError(`${name} must not be empty`);
  if (value.includes('\0')) throw new TypeError(`${name} must not contain a null byte`);
};

const assertArgument = (name: string, value: string): void => {
  if (value.includes('\0')) throw new TypeError(`${name} must not contain a null byte`);
};

const environmentName = /^[A-Za-z_][A-Za-z0-9_]*$/u;

export const validateCommand = (command: CommandDescriptor): void => {
  assertText('executable', command.executable);
  command.arguments?.forEach((argument, index) => {
    assertArgument(`arguments[${String(index)}]`, argument);
  });
  if (command.cwd !== undefined) assertText('cwd', command.cwd);
  if (command.label !== undefined) assertText('label', command.label.trim());

  for (const [name, value] of Object.entries(command.environment ?? {})) {
    if (!environmentName.test(name)) throw new TypeError(`invalid environment variable name: ${name}`);
    if (value !== undefined && value.includes('\0')) {
      throw new TypeError(`environment variable ${name} must not contain a null byte`);
    }
  }
};

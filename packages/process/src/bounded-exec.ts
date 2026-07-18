import type { BoundedExecCommand, BoundedExecHost, BoundedExecResult } from './command.js';
import { validateCommand } from './command.js';
import { BoundedExecError, type BoundedExecFailureReason } from './errors.js';
import { createRedactor, formatCommand, type Redactor } from './redaction.js';

interface BashOptions {
  readonly context?: string;
  readonly maxBufferBytes?: number;
  readonly timeoutMs?: number;
}

export type BashExecutor = (command: string, options?: BashOptions) => Promise<string>;

interface BashFailure {
  readonly exitCode?: number | null;
  readonly reason?: string;
  readonly signal?: NodeJS.Signals | null;
  readonly stderr?: string;
  readonly stdout?: string;
}

const quote = (value: string): string => `'${value.replaceAll("'", "'\"'\"'")}'`;

const environmentArguments = (environment: BoundedExecCommand['environment']): string[] => {
  const entries = Object.entries(environment ?? {});
  const unset = entries.flatMap(([name, value]) => value === undefined ? ['-u', quote(name)] : []);
  const defined = entries.flatMap(([name, value]) =>
    value === undefined ? [] : [quote(`${name}=${value}`)],
  );
  return [...unset, '--', ...defined];
};

export const toBoundedShellCommand = (command: BoundedExecCommand): string => {
  validateCommand(command);
  const invocation = [quote(command.executable), ...(command.arguments ?? []).map(quote)];
  const environment = command.environment === undefined
    ? []
    : environmentArguments(command.environment);
  const withEnvironment = environment.length === 0
    ? invocation
    : ['env', ...environment, ...invocation];
  if (command.cwd === undefined) return withEnvironment.join(' ');
  return `cd -- ${quote(command.cwd)} && ${withEnvironment.join(' ')}`;
};

const contextFor = (command: BoundedExecCommand, redact: Redactor): string => {
  const context = redact(command.label ?? `run ${command.executable}`)
    .replace(/[\r\n\t]+/gu, ' ')
    .trim();
  return context.slice(0, 120);
};

const failureReason = (reason: string | undefined): BoundedExecFailureReason => {
  if (reason === 'max-buffer' || reason === 'signal' || reason === 'timeout') return reason;
  return 'exit';
};

/**
 * Adapts ts-bash's bounded shell execution to structured command descriptors.
 * The adapter is intentionally only an exec boundary: it cannot stream, inherit a TTY,
 * detach, or represent a long-running process.
 */
export class TypescriptBashExecAdapter implements BoundedExecHost {
  readonly #bash: BashExecutor;
  readonly #redact: Redactor;

  constructor(bash: BashExecutor, redactor: Redactor = value => value) {
    this.#bash = bash;
    this.#redact = redactor;
  }

  async exec(command: BoundedExecCommand): Promise<BoundedExecResult> {
    const shellCommand = toBoundedShellCommand(command);
    const redact = createRedactor(command.sensitiveValues, this.#redact);

    try {
      const stdout = await this.#bash(shellCommand, {
        context: contextFor(command, redact),
        ...(command.maxOutputBytes === undefined ? {} : { maxBufferBytes: command.maxOutputBytes }),
        ...(command.timeoutMs === undefined ? {} : { timeoutMs: command.timeoutMs }),
      });
      return { exitCode: 0, signal: null, stderr: '', stdout };
    } catch (error) {
      const failure = error as BashFailure;
      throw new BoundedExecError({
        command: formatCommand(command, this.#redact),
        exitCode: failure.exitCode ?? null,
        reason: failureReason(failure.reason),
        signal: failure.signal ?? null,
        stderr: redact(failure.stderr ?? ''),
        stdout: redact(failure.stdout ?? ''),
      });
    }
  }
}

import type { SpawnCompletionReason } from './command.js';

export type BoundedExecFailureReason = 'exit' | 'max-buffer' | 'signal' | 'timeout';

interface BoundedExecErrorDetails {
  readonly command: string;
  readonly exitCode: number | null;
  readonly reason: BoundedExecFailureReason;
  readonly signal: NodeJS.Signals | null;
  readonly stderr: string;
  readonly stdout: string;
}

export class BoundedExecError extends Error {
  readonly command: string;
  readonly exitCode: number | null;
  readonly reason: BoundedExecFailureReason;
  readonly signal: NodeJS.Signals | null;
  readonly stderr: string;
  readonly stdout: string;

  constructor(details: BoundedExecErrorDetails) {
    super(`Bounded command failed (${details.reason}): ${details.command}`);
    this.name = 'BoundedExecError';
    this.command = details.command;
    this.exitCode = details.exitCode;
    this.reason = details.reason;
    this.signal = details.signal;
    this.stderr = details.stderr;
    this.stdout = details.stdout;
  }
}

export class CommandStartError extends Error {
  readonly code: string | undefined;
  readonly command: string;

  constructor(command: string, code?: string) {
    super(`Could not start command${code === undefined ? '' : ` (${code})`}: ${command}`);
    this.name = 'CommandStartError';
    this.code = code;
    this.command = command;
  }
}

export class FakeCommandScriptError extends Error {
  constructor(operation: 'exec' | 'spawn') {
    super(`No scripted ${operation} result remains`);
    this.name = 'FakeCommandScriptError';
  }
}

export const reasonFromExit = (
  exitCode: number | null,
  signal: NodeJS.Signals | null,
): Extract<SpawnCompletionReason, 'exit' | 'signal'> =>
  signal === null && exitCode !== null ? 'exit' : 'signal';

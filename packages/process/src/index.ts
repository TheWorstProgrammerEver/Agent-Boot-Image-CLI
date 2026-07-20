export { TypescriptBashExecAdapter, type BashExecutor } from './bounded-exec.js';
export {
  type BoundedExecCommand,
  type BoundedExecHost,
  type BoundedExecResult,
  type CommandDescriptor,
  type CommandHost,
  type RunningCommand,
  type SpawnCommand,
  type SpawnCompletionReason,
  type SpawnHost,
  type SpawnLifetime,
  type SpawnOutputChunk,
  type SpawnOutputStream,
  type SpawnResult,
  type TerminalStdio,
} from './command.js';
export { CompositeCommandHost } from './composite-command-host.js';
export { BoundedExecError, CommandStartError, FakeCommandScriptError } from './errors.js';
export { FakeCommandHost, type FakeSpawnScript } from './fake-command-host.js';
export {
  NodeSpawnAdapter,
  type NodeSpawnAdapterOptions,
  type SignalSource,
  type TerminalInspector,
  type SpawnProcess,
} from './spawn.js';
export {
  createRedactor,
  formatCommand,
  redactedValue,
  representCommand,
  type CommandRepresentation,
  type Redactor,
} from './redaction.js';

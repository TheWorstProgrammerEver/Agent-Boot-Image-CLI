import type { CommandDescriptor } from './command.js';

export type Redactor = (value: string) => string;

export const redactedValue = '[REDACTED]';

export const createRedactor = (
  sensitiveValues: readonly string[] = [],
  baseRedactor: Redactor = value => value,
): Redactor => {
  const values = [...new Set(sensitiveValues.filter(value => value.length > 0))]
    .sort((left, right) => right.length - left.length);

  return (value) => values.reduce(
    (redacted, sensitive) => redacted.replaceAll(sensitive, redactedValue),
    baseRedactor(value),
  );
};

export interface CommandRepresentation {
  readonly arguments: readonly string[];
  readonly cwd?: string;
  readonly environmentKeys: readonly string[];
  readonly executable: string;
  readonly label?: string;
}

export const representCommand = (
  command: CommandDescriptor,
  baseRedactor?: Redactor,
): CommandRepresentation => {
  const redact = createRedactor(command.sensitiveValues, baseRedactor);

  return {
    arguments: (command.arguments ?? []).map(redact),
    ...(command.cwd === undefined ? {} : { cwd: redact(command.cwd) }),
    environmentKeys: Object.keys(command.environment ?? {}).sort(),
    executable: redact(command.executable),
    ...(command.label === undefined ? {} : { label: redact(command.label) }),
  };
};

export const formatCommand = (command: CommandDescriptor, baseRedactor?: Redactor): string => {
  const representation = representCommand(command, baseRedactor);
  const invocation = [representation.executable, ...representation.arguments]
    .map(value => JSON.stringify(value))
    .join(' ');
  return representation.label === undefined ? invocation : `${representation.label}: ${invocation}`;
};

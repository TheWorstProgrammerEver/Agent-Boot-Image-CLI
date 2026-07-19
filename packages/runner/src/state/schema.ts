import { constants as osConstants } from "node:os";

import { CheckpointValidationError } from "./errors.js";
import {
  RUNNER_CHECKPOINT_SCHEMA_VERSION,
  type FireAndForgetProcessCheckpoint,
  type FireAndForgetProcessOutcome,
  type FireAndForgetProcessPhase,
  type ProcessIdentity,
  type RunnerCheckpoint,
  type RunnerDiagnostic,
  type RunnerDiagnosticCode,
  type RunnerPlanIdentity,
  type RunnerRecoveryAction,
  type SecretTransactionCheckpoint,
  type SecretTransactionPhase,
  type StepCheckpoint,
  type StepCheckpointPhase,
  type TerminalCheckpoint,
} from "./model.js";

type JsonObject = Record<string, unknown>;

const hasOwn = (value: JsonObject, key: string): boolean => Object.hasOwn(value, key);

const fail = (path: string, message: string): never => {
  throw new CheckpointValidationError(`${path}: ${message}`);
};

const object = (input: unknown, path: string, allowed: readonly string[]): JsonObject => {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    fail(path, "Expected an object.");
  }
  const value = input as JsonObject;
  const allowedKeys = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedKeys.has(key)) fail(`${path}.${key}`, "Unknown field.");
  }
  return value;
};

const required = (value: JsonObject, key: string, path: string): unknown => {
  if (!hasOwn(value, key)) fail(`${path}.${key}`, "Required field is missing.");
  return value[key];
};

const string = (input: unknown, path: string, maximum = 256): string => {
  if (typeof input !== "string") {
    fail(path, `Expected a non-empty string no longer than ${String(maximum)} characters.`);
  }
  const value = input as string;
  if (value.length === 0 || value.length > maximum) {
    fail(path, `Expected a non-empty string no longer than ${String(maximum)} characters.`);
  }
  if (value.includes("\0")) fail(path, "Null bytes are not permitted.");
  return value;
};

const integer = (input: unknown, path: string, minimum: number, maximum: number): number => {
  if (typeof input !== "number") {
    fail(path, `Expected an integer from ${String(minimum)} through ${String(maximum)}.`);
  }
  const value = input as number;
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    fail(path, `Expected an integer from ${String(minimum)} through ${String(maximum)}.`);
  }
  return value;
};

const nullableInteger = (input: unknown, path: string): number | null =>
  input === null ? null : integer(input, path, 0, 255);

const enumeration = <T extends string>(
  input: unknown,
  path: string,
  values: ReadonlySet<T>,
): T => {
  if (typeof input !== "string" || !values.has(input as T)) fail(path, "Unknown value.");
  return input as T;
};

const identifierPattern = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/u;

const identifier = (input: unknown, path: string): string => {
  const value = string(input, path, 128);
  if (!identifierPattern.test(value)) fail(path, "Expected a lowercase identifier.");
  return value;
};

const relativePath = (input: unknown, path: string): string => {
  const value = string(input, path, 512);
  const parts = value.split("/");
  if (
    value.startsWith("/") ||
    value.endsWith("/") ||
    value.includes("\\") ||
    parts.some((part) => part === "" || part === "." || part === "..")
  ) {
    fail(path, "Expected a normalized relative path without traversal.");
  }
  return value;
};

const timestamp = (input: unknown, path: string): string => {
  const value = string(input, path, 32);
  const parsed = new Date(value);
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString() !== value) {
    fail(path, "Expected an ISO-8601 UTC timestamp.");
  }
  return value;
};

const digest = (input: unknown, path: string): string => {
  const value = string(input, path, 64);
  if (!/^[a-f0-9]{64}$/u.test(value)) fail(path, "Expected a lowercase SHA-256 digest.");
  return value;
};

const parsePlan = (input: unknown, path: string): RunnerPlanIdentity => {
  const value = object(input, path, ["agentId", "planSha256", "schemaVersion"]);
  return {
    agentId: identifier(required(value, "agentId", path), `${path}.agentId`),
    planSha256: digest(required(value, "planSha256", path), `${path}.planSha256`),
    schemaVersion: integer(required(value, "schemaVersion", path), `${path}.schemaVersion`, 1, 255),
  };
};

const stepPhases = new Set<StepCheckpointPhase>(["started", "succeeded", "failed"]);

const parseStep = (input: unknown, path: string): StepCheckpoint => {
  const value = object(input, path, ["attempt", "id", "index", "phase"]);
  return {
    attempt: integer(required(value, "attempt", path), `${path}.attempt`, 1, 1_000_000),
    id: identifier(required(value, "id", path), `${path}.id`),
    index: integer(required(value, "index", path), `${path}.index`, 0, 1_000_000),
    phase: enumeration(required(value, "phase", path), `${path}.phase`, stepPhases),
  };
};

const parseProcessIdentity = (input: unknown, path: string): ProcessIdentity => {
  const value = object(input, path, ["bootId", "pid", "processGroupId", "startTimeTicks"]);
  const bootId = string(required(value, "bootId", path), `${path}.bootId`, 36);
  if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(bootId)) {
    fail(`${path}.bootId`, "Expected a lowercase Linux boot UUID.");
  }
  const startTimeTicks = string(
    required(value, "startTimeTicks", path),
    `${path}.startTimeTicks`,
    32,
  );
  if (!/^[1-9][0-9]*$/u.test(startTimeTicks)) {
    fail(`${path}.startTimeTicks`, "Expected positive decimal clock ticks.");
  }
  const pid = integer(required(value, "pid", path), `${path}.pid`, 2, 4_194_304);
  const processGroupId = integer(
    required(value, "processGroupId", path),
    `${path}.processGroupId`,
    2,
    4_194_304,
  );
  if (processGroupId !== pid) {
    fail(`${path}.processGroupId`, "Expected an isolated process group led by the recorded PID.");
  }
  return {
    bootId,
    pid,
    processGroupId,
    startTimeTicks,
  };
};

const processPhases = new Set<FireAndForgetProcessPhase>([
  "registered",
  "accepted",
  "finished",
]);
const processOutcomes = new Set<FireAndForgetProcessOutcome>([
  "exited-before-acceptance",
  "exited-after-acceptance",
  "reconciled-missing",
  "runner-shutdown",
]);

const parseProcess = (input: unknown, path: string): FireAndForgetProcessCheckpoint => {
  const value = object(input, path, [
    "acceptedAt",
    "exitCode",
    "finishedAt",
    "generation",
    "identity",
    "lifetime",
    "outcome",
    "phase",
    "registeredAt",
    "signal",
    "stepId",
    "stepIndex",
  ]);
  const phase = enumeration(required(value, "phase", path), `${path}.phase`, processPhases);
  const common = {
    generation: integer(required(value, "generation", path), `${path}.generation`, 1, 1_000_000),
    identity: parseProcessIdentity(required(value, "identity", path), `${path}.identity`),
    lifetime: enumeration(
      required(value, "lifetime", path),
      `${path}.lifetime`,
      new Set<"runner">(["runner"]),
    ),
    registeredAt: timestamp(required(value, "registeredAt", path), `${path}.registeredAt`),
    stepId: identifier(required(value, "stepId", path), `${path}.stepId`),
    stepIndex: integer(required(value, "stepIndex", path), `${path}.stepIndex`, 0, 1_000_000),
  };
  if (phase === "registered") {
    for (const field of ["acceptedAt", "exitCode", "finishedAt", "outcome", "signal"]) {
      if (hasOwn(value, field)) fail(`${path}.${field}`, "Registered processes cannot include this field.");
    }
    return { ...common, phase };
  }
  if (phase === "accepted") {
    for (const field of ["exitCode", "finishedAt", "outcome", "signal"]) {
      if (hasOwn(value, field)) fail(`${path}.${field}`, "Accepted processes cannot include this field.");
    }
    return {
      ...common,
      acceptedAt: timestamp(required(value, "acceptedAt", path), `${path}.acceptedAt`),
      phase,
    };
  }

  const outcome = enumeration(
    required(value, "outcome", path),
    `${path}.outcome`,
    processOutcomes,
  );
  const acceptedAt = hasOwn(value, "acceptedAt")
    ? timestamp(value.acceptedAt, `${path}.acceptedAt`)
    : undefined;
  if (outcome === "exited-before-acceptance" && acceptedAt !== undefined) {
    fail(`${path}.acceptedAt`, "An early exit cannot have been accepted.");
  }
  if (outcome === "exited-after-acceptance" && acceptedAt === undefined) {
    fail(`${path}.acceptedAt`, "A later exit requires prior acceptance.");
  }
  return {
    ...common,
    ...(acceptedAt === undefined ? {} : { acceptedAt }),
    exitCode: nullableInteger(required(value, "exitCode", path), `${path}.exitCode`),
    finishedAt: timestamp(required(value, "finishedAt", path), `${path}.finishedAt`),
    outcome,
    phase,
    signal: parseSignal(required(value, "signal", path), `${path}.signal`),
  };
};

const transactionPhases = new Set<SecretTransactionPhase>([
  "prepared",
  "installed",
  "source-removed",
  "committed",
]);

const parseSecretTransaction = (
  input: unknown,
  path: string,
): SecretTransactionCheckpoint => {
  const value = object(input, path, ["destination", "phase", "secretId", "stepId"]);
  return {
    destination: relativePath(required(value, "destination", path), `${path}.destination`),
    phase: enumeration(required(value, "phase", path), `${path}.phase`, transactionPhases),
    secretId: identifier(required(value, "secretId", path), `${path}.secretId`),
    stepId: identifier(required(value, "stepId", path), `${path}.stepId`),
  };
};

const diagnosticCodes = new Set<RunnerDiagnosticCode>([
  "step-attempt-failed",
  "manual-command-failed",
  "manual-completion-check-failed",
  "manual-gate-incomplete",
  "prompt-cleanup-failed",
  "prompt-hydration-failed",
  "provider-execution-failed",
  "fire-and-forget-launch-failed",
  "fire-and-forget-early-exit",
  "fire-and-forget-process-exited",
  "fire-and-forget-reconciliation-failed",
  "secret-transaction-failed",
  "state-persistence-failed",
  "manual-intervention-required",
]);
const recoveryActions = new Set<RunnerRecoveryAction>([
  "retry-step",
  "resume-secret-transaction",
  "inspect-state-storage",
  "manual-intervention",
]);

const parseSignal = (input: unknown, path: string): NodeJS.Signals | null => {
  if (input === null) return null;
  const value = string(input, path, 32);
  if (!(value in osConstants.signals)) fail(path, "Expected a supported POSIX signal name.");
  return value as NodeJS.Signals;
};

const parseDiagnostic = (input: unknown, path: string): RunnerDiagnostic => {
  const value = object(input, path, [
    "attempt",
    "code",
    "exitCode",
    "recovery",
    "signal",
    "stepId",
  ]);
  return {
    code: enumeration(required(value, "code", path), `${path}.code`, diagnosticCodes),
    recovery: enumeration(
      required(value, "recovery", path),
      `${path}.recovery`,
      recoveryActions,
    ),
    ...(hasOwn(value, "attempt")
      ? { attempt: integer(value.attempt, `${path}.attempt`, 1, 1_000_000) }
      : {}),
    ...(hasOwn(value, "exitCode")
      ? { exitCode: nullableInteger(value.exitCode, `${path}.exitCode`) }
      : {}),
    ...(hasOwn(value, "signal") ? { signal: parseSignal(value.signal, `${path}.signal`) } : {}),
    ...(hasOwn(value, "stepId") ? { stepId: identifier(value.stepId, `${path}.stepId`) } : {}),
  };
};

const parseTerminal = (input: unknown, path: string): TerminalCheckpoint => {
  const discriminator = object(input, path, ["at", "diagnostic", "status"]);
  const status = required(discriminator, "status", path);
  if (status === "succeeded") {
    const value = object(input, path, ["at", "status"]);
    return { at: timestamp(required(value, "at", path), `${path}.at`), status };
  }
  if (status === "failed") {
    return {
      at: timestamp(required(discriminator, "at", path), `${path}.at`),
      diagnostic: parseDiagnostic(
        required(discriminator, "diagnostic", path),
        `${path}.diagnostic`,
      ),
      status,
    };
  }
  return fail(`${path}.status`, "Expected succeeded or failed.");
};

export const checkpointSchemaVersion = (input: unknown): unknown =>
  typeof input === "object" && input !== null && !Array.isArray(input)
    ? (input as JsonObject).schemaVersion
    : undefined;

const validateCheckpointInvariants = (
  checkpoint: RunnerCheckpoint,
  path: string,
): RunnerCheckpoint => {
  const {
    currentStep,
    fireAndForgetProcesses,
    revision,
    secretTransaction,
    terminal,
    updatedAt,
  } = checkpoint;
  const pristine =
    currentStep === null &&
    fireAndForgetProcesses.length === 0 &&
    secretTransaction === null &&
    terminal === null;
  if ((revision === 0) !== pristine) {
    fail(`${path}.revision`, "Revision zero must identify exactly an unmodified checkpoint.");
  }
  if (secretTransaction !== null) {
    if (currentStep === null) {
      fail(`${path}.secretTransaction`, "A secret transaction requires a current step.");
    } else if (secretTransaction.stepId !== currentStep.id) {
      fail(
        `${path}.secretTransaction.stepId`,
        "The secret transaction must belong to the current step.",
      );
    } else if (
      currentStep.phase === "succeeded" &&
      secretTransaction.phase !== "committed"
    ) {
      fail(
        `${path}.secretTransaction.phase`,
        "A succeeded step cannot retain an incomplete secret transaction.",
      );
    }
  }
  if (
    terminal?.status === "succeeded" &&
    currentStep !== null &&
    currentStep.phase !== "succeeded"
  ) {
    fail(`${path}.terminal.status`, "Terminal success requires a succeeded current step.");
  }
  if (
    terminal?.status === "succeeded" &&
    secretTransaction !== null &&
    secretTransaction.phase !== "committed"
  ) {
    fail(
      `${path}.terminal.status`,
      "Terminal success cannot retain an incomplete secret transaction.",
    );
  }
  if (terminal !== null && terminal.at !== updatedAt) {
    fail(`${path}.terminal.at`, "A terminal checkpoint must be the final update.");
  }
  if (terminal !== null && fireAndForgetProcesses.some((process) => process.phase !== "finished")) {
    fail(`${path}.fireAndForgetProcesses`, "Terminal state cannot retain an active process.");
  }
  const stepIds = new Set<string>();
  const stepIndexes = new Set<number>();
  for (const process of fireAndForgetProcesses) {
    if (stepIds.has(process.stepId)) {
      fail(`${path}.fireAndForgetProcesses`, "Process step identifiers must be unique.");
    }
    if (stepIndexes.has(process.stepIndex)) {
      fail(`${path}.fireAndForgetProcesses`, "Process step indexes must be unique.");
    }
    stepIds.add(process.stepId);
    stepIndexes.add(process.stepIndex);
  }
  return checkpoint;
};

export const parseRunnerCheckpoint = (input: unknown): RunnerCheckpoint => {
  const path = "runner-checkpoint.json";
  const value = object(input, path, [
    "currentStep",
    "fireAndForgetProcesses",
    "plan",
    "revision",
    "schemaVersion",
    "secretTransaction",
    "terminal",
    "updatedAt",
  ]);
  const schemaVersion = required(value, "schemaVersion", path);
  if (schemaVersion !== RUNNER_CHECKPOINT_SCHEMA_VERSION) {
    fail(`${path}.schemaVersion`, `Expected ${String(RUNNER_CHECKPOINT_SCHEMA_VERSION)}.`);
  }
  const currentStep = required(value, "currentStep", path);
  const processInput = required(value, "fireAndForgetProcesses", path);
  const processes = Array.isArray(processInput)
    ? processInput
    : fail(`${path}.fireAndForgetProcesses`, "Expected an array with at most 256 entries.");
  if (processes.length > 256) {
    fail(`${path}.fireAndForgetProcesses`, "Expected an array with at most 256 entries.");
  }
  const secretTransaction = required(value, "secretTransaction", path);
  const terminal = required(value, "terminal", path);
  return validateCheckpointInvariants({
    currentStep:
      currentStep === null ? null : parseStep(currentStep, `${path}.currentStep`),
    fireAndForgetProcesses: processes.map((process, index) =>
      parseProcess(process, `${path}.fireAndForgetProcesses[${String(index)}]`),
    ),
    plan: parsePlan(required(value, "plan", path), `${path}.plan`),
    revision: integer(required(value, "revision", path), `${path}.revision`, 0, 1_000_000_000),
    schemaVersion: RUNNER_CHECKPOINT_SCHEMA_VERSION,
    secretTransaction:
      secretTransaction === null
        ? null
        : parseSecretTransaction(secretTransaction, `${path}.secretTransaction`),
    terminal: terminal === null ? null : parseTerminal(terminal, `${path}.terminal`),
    updatedAt: timestamp(required(value, "updatedAt", path), `${path}.updatedAt`),
  }, path);
};

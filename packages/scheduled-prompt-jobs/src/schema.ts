import { PromptJobValidationError } from "./errors.js";
import {
  PROMPT_JOB_SCHEMA_VERSION,
  SUPPORTED_PROMPT_JOB_MODELS,
  SUPPORTED_REASONING_EFFORTS,
  type ScheduledPromptJob,
  type ScheduledPromptManifest,
} from "./model.js";

const jobIdPattern = /^[a-z][a-z0-9-]{0,47}$/u;
const calendarPattern = /^[A-Za-z0-9*:,./_+@~ -]{1,120}$/u;
const jobFields = [
  "effectPolicy",
  "id",
  "logRetention",
  "model",
  "onCalendar",
  "overlapGroup",
  "persistent",
  "prompt",
  "randomizedDelaySeconds",
  "reasoningEffort",
  "timeoutSeconds",
  "workingDirectory",
] as const;

const fail = (path: string, reason: string): never => {
  throw new PromptJobValidationError(path, reason);
};

const object = (
  input: unknown,
  path: string,
  fields: readonly string[],
): Record<string, unknown> => {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return fail(path, "Expected an object.");
  }
  const value = input as Record<string, unknown>;
  const allowed = new Set(fields);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail(`${path}.${key}`, `Unknown field ${JSON.stringify(key)}.`);
  }
  for (const key of fields) {
    if (!Object.hasOwn(value, key)) fail(`${path}.${key}`, "Required field is missing.");
  }
  return value;
};

const string = (input: unknown, path: string, maximum = 512): string => {
  if (typeof input !== "string" || input.length === 0 || input.length > maximum) {
    return fail(path, `Expected 1-${String(maximum)} characters.`);
  }
  if (input.includes("\0")) fail(path, "NUL characters are not permitted.");
  return input;
};

const integer = (input: unknown, path: string, minimum: number, maximum: number): number => {
  if (typeof input !== "number" || !Number.isSafeInteger(input)) {
    return fail(path, "Expected a safe integer.");
  }
  if (input < minimum || input > maximum) {
    fail(path, `Expected a value between ${String(minimum)} and ${String(maximum)}.`);
  }
  return input;
};

const boolean = (input: unknown, path: string): boolean =>
  typeof input === "boolean" ? input : fail(path, "Expected a boolean.");

const identifier = (input: unknown, path: string): string => {
  const value = string(input, path, 48);
  if (!jobIdPattern.test(value)) fail(path, "Expected a safe lowercase job identifier.");
  return value;
};

const relativePath = (input: unknown, path: string): string => {
  const value = string(input, path);
  const parts = value.split("/");
  if (
    value.startsWith("/") || value.endsWith("/") || value.includes("\\") ||
    parts.some(part => part === "" || part === "." || part === "..")
  ) fail(path, "Expected a normalized relative path without traversal.");
  return value;
};

const member = <T extends string>(
  input: unknown,
  path: string,
  supported: readonly T[],
): T => {
  const value = string(input, path);
  if (!supported.includes(value as T)) {
    fail(path, `Expected one of: ${supported.join(", ")}.`);
  }
  return value as T;
};

const job = (input: unknown, path: string): ScheduledPromptJob => {
  const value = object(input, path, jobFields);
  const prompt = relativePath(value.prompt, `${path}.prompt`);
  if (!prompt.endsWith(".md")) fail(`${path}.prompt`, "Expected a Markdown prompt path.");
  const onCalendar = string(value.onCalendar, `${path}.onCalendar`, 120);
  if (!calendarPattern.test(onCalendar) || /[\r\n]/u.test(onCalendar)) {
    fail(`${path}.onCalendar`, "Expected a bounded systemd calendar expression.");
  }
  const persistent = boolean(value.persistent, `${path}.persistent`);
  return {
    effectPolicy: member(
      value.effectPolicy,
      `${path}.effectPolicy`,
      ["read-only"] as const,
    ),
    id: identifier(value.id, `${path}.id`),
    logRetention: integer(value.logRetention, `${path}.logRetention`, 1, 100),
    model: member(
      value.model,
      `${path}.model`,
      SUPPORTED_PROMPT_JOB_MODELS,
    ),
    onCalendar,
    overlapGroup: identifier(value.overlapGroup, `${path}.overlapGroup`),
    persistent,
    prompt,
    randomizedDelaySeconds: integer(
      value.randomizedDelaySeconds,
      `${path}.randomizedDelaySeconds`,
      0,
      86_400,
    ),
    reasoningEffort: member(
      value.reasoningEffort,
      `${path}.reasoningEffort`,
      SUPPORTED_REASONING_EFFORTS,
    ),
    timeoutSeconds: integer(value.timeoutSeconds, `${path}.timeoutSeconds`, 30, 43_200),
    workingDirectory: relativePath(value.workingDirectory, `${path}.workingDirectory`),
  };
};

export const parseScheduledPromptManifest = (input: unknown): ScheduledPromptManifest => {
  const value = object(input, "$", ["version", "jobs"]);
  if (value.version !== PROMPT_JOB_SCHEMA_VERSION) {
    fail("$.version", `Expected ${String(PROMPT_JOB_SCHEMA_VERSION)}.`);
  }
  if (!Array.isArray(value.jobs)) fail("$.jobs", "Expected an array.");
  const jobsInput = value.jobs as unknown[];
  if (jobsInput.length < 1 || jobsInput.length > 32) {
    fail("$.jobs", "Expected 1-32 jobs.");
  }
  const jobs = jobsInput.map((inputJob, index) => job(inputJob, `$.jobs[${String(index)}]`));
  const ids = new Set<string>();
  for (const [index, parsed] of jobs.entries()) {
    if (ids.has(parsed.id)) fail(`$.jobs[${String(index)}].id`, "Duplicate job identifier.");
    ids.add(parsed.id);
  }
  return { jobs, version: PROMPT_JOB_SCHEMA_VERSION };
};

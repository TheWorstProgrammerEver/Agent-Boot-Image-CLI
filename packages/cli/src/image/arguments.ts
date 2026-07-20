import type { ImageCommandRequest } from "./model.js";

const valueFlags = new Set([
  "--cache-directory",
  "--definition",
  "--expect-model",
  "--expect-serial",
  "--expect-transport",
  "--lock-directory",
  "--max-size-bytes",
  "--runner-bundle",
  "--runner-entrypoint",
  "--runner-runtime",
  "--target",
]);

export const IMAGE_USAGE =
  "Usage: create-agent image --definition <definition.ts> --runner-runtime <file> " +
  "--runner-entrypoint <file> --runner-bundle <directory> --cache-directory <directory> " +
  "--lock-directory <directory> --target </dev/disk/by-id/...> --expect-model <model> " +
  "--expect-serial <serial> --expect-transport <transport> --max-size-bytes <bytes> " +
  "[--yes] [--dry-run]";

const parsePositiveInteger = (value: string | undefined): number | undefined => {
  if (value === undefined || !/^[1-9][0-9]*$/u.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
};

export const parseImageArguments = (
  arguments_: readonly string[],
): ImageCommandRequest | undefined => {
  const values = new Map<string, string>();
  let dryRun = false;
  let yes = false;
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index] as string;
    if (argument === "--dry-run" || argument === "--yes") {
      if (argument === "--dry-run" ? dryRun : yes) return undefined;
      if (argument === "--dry-run") dryRun = true;
      else yes = true;
      continue;
    }
    if (!valueFlags.has(argument) || values.has(argument)) return undefined;
    const value = arguments_[index + 1];
    if (value === undefined || value.length === 0 || value.startsWith("--")) return undefined;
    values.set(argument, value);
    index += 1;
  }

  const maximum = parsePositiveInteger(values.get("--max-size-bytes"));
  const target = values.get("--target");
  if (
    maximum === undefined || target === undefined ||
    !target.startsWith("/dev/disk/by-id/") ||
    target.slice("/dev/disk/by-id/".length).includes("/")
  ) return undefined;

  const required = [
    "--cache-directory",
    "--definition",
    "--expect-model",
    "--expect-serial",
    "--expect-transport",
    "--lock-directory",
    "--runner-bundle",
    "--runner-entrypoint",
    "--runner-runtime",
  ] as const;
  if (required.some(flag => values.get(flag)?.trim().length === 0 || !values.has(flag))) {
    return undefined;
  }

  return {
    cacheDirectory: values.get("--cache-directory") as string,
    definitionPath: values.get("--definition") as string,
    dryRun,
    expectedModel: values.get("--expect-model") as string,
    expectedSerial: values.get("--expect-serial") as string,
    expectedTransport: values.get("--expect-transport") as string,
    lockDirectory: values.get("--lock-directory") as string,
    maxSizeBytes: maximum,
    runnerBundleDirectory: values.get("--runner-bundle") as string,
    runnerEntrypointPath: values.get("--runner-entrypoint") as string,
    runnerRuntimePath: values.get("--runner-runtime") as string,
    stableTarget: target,
    yes,
  };
};

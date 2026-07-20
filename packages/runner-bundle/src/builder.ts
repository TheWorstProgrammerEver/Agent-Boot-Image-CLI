import { constants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  realpath,
  rename,
  rm,
} from "node:fs/promises";
import { basename, dirname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { RUNNER_CHECKPOINT_SCHEMA_VERSION } from "@agent-boot/runner";
import { SCHEMA_VERSION } from "@agent-boot/protocol";

import { canonicalJson } from "./canonical-json.js";
import { sha256 } from "./digest.js";
import { verifyRunnerBundle } from "./manifest.js";
import {
  RUNNER_BUNDLE_SCHEMA_VERSION,
  type BuildRunnerBundleOptions,
  type RunnerBundleManifest,
} from "./model.js";
import { verifyNodeRuntime } from "./node-runtime.js";
import {
  BUNDLE_MANIFEST_PATH,
  BUNDLE_ROOT_PATH,
  RUNNER_SERVICE_NAME,
  bundlePathForTarget,
} from "./paths.js";
import { renderRunnerService } from "./systemd.js";
import { bundleEntries, copyTree, inspectTree } from "./tree.js";

const packageNames = ["process", "protocol", "runner", "runner-bundle"] as const;

const defaultPackageDirectories = (): Record<(typeof packageNames)[number], string> =>
  Object.fromEntries(packageNames.map((name) => [
    name,
    fileURLToPath(new URL(`../../${name}`, import.meta.url)),
  ])) as Record<(typeof packageNames)[number], string>;

const writeFile = async (path: string, contents: string, mode: number): Promise<void> => {
  await mkdir(dirname(path), { mode: 0o755, recursive: true });
  const handle = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, mode);
  try {
    await handle.writeFile(contents);
    await handle.chmod(mode);
    await handle.sync();
  } finally {
    await handle.close();
  }
};

const createDirectory = async (root: string, targetPath: string, mode: number): Promise<void> => {
  const path = join(root, ...targetPath.slice(1).split("/"));
  await mkdir(path, { mode, recursive: true });
  await chmod(path, mode);
};

const prepareTargetDirectories = async (root: string): Promise<void> => {
  const publicDirectories = [
    "/opt",
    "/opt/agent-boot",
    "/opt/agent-boot/runtime",
    "/opt/agent-boot/scripts",
    "/opt/agent-boot/scripts/bin",
    "/opt/agent-boot/scripts/node_modules",
    "/opt/agent-boot/scripts/node_modules/@agent-boot",
    "/opt/agent-boot/assets",
    "/opt/agent-boot/prompts",
    "/etc",
    "/etc/systemd",
    "/etc/systemd/system",
    "/var",
    "/var/lib",
    "/run",
  ];
  const privateDirectories = [
    "/etc/agent-boot/bootstrap-secrets",
    "/var/lib/agent-boot",
    "/run/agent-boot/prompts",
    "/run/agent-boot/secrets",
  ];
  for (const path of publicDirectories) await createDirectory(root, path, 0o755);
  await createDirectory(root, "/etc/agent-boot", 0o750);
  for (const path of privateDirectories) await createDirectory(root, path, 0o700);
};

const copyPackage = async (source: string, destination: string): Promise<void> => {
  const dist = join(source, "dist");
  const records = (await inspectTree(dist)).filter((record) =>
    record.kind === "directory" || record.path.endsWith(".js"));
  await copyTree(dist, join(destination, "dist"), records);
  const packageJson = await open(join(source, "package.json"), "r");
  try {
    const destinationPackage = await open(join(destination, "package.json"), "wx", 0o644);
    try {
      await destinationPackage.writeFile(await packageJson.readFile());
      await destinationPackage.sync();
    } finally {
      await destinationPackage.close();
    }
  } finally {
    await packageJson.close();
  }
};

const runnerLauncher = [
  "#!/opt/agent-boot/runtime/bin/node",
  'import { runRunnerService } from "@agent-boot/runner-bundle/runtime";',
  "await runRunnerService();",
  "",
].join("\n");

const codexLauncher = [
  "#!/opt/agent-boot/runtime/bin/node",
  'await import("@agent-boot/runner/providers/codex/bin");',
  "",
].join("\n");

const writeTargetAssets = async (
  root: string,
  options: BuildRunnerBundleOptions,
): Promise<void> => {
  await prepareTargetDirectories(root);
  const runtimeRecords = await verifyNodeRuntime(options.nodeRuntimeDirectory, options.node);
  await copyTree(
    options.nodeRuntimeDirectory,
    join(root, "opt", "agent-boot", "runtime"),
    runtimeRecords,
  );

  const packageDirectories = options.packageDirectories ?? defaultPackageDirectories();
  for (const name of packageNames) {
    await copyPackage(
      packageDirectories[name],
      join(root, "opt", "agent-boot", "scripts", "node_modules", "@agent-boot", name),
    );
  }
  await writeFile(
    join(root, "opt", "agent-boot", "scripts", "bin", "agent-boot-runner"),
    runnerLauncher,
    0o755,
  );
  await writeFile(
    join(root, "opt", "agent-boot", "scripts", "bin", "agent-boot-codex"),
    codexLauncher,
    0o755,
  );
  await writeFile(
    join(root, "etc", "systemd", "system", RUNNER_SERVICE_NAME),
    renderRunnerService(options.account),
    0o644,
  );
};

const createManifest = async (
  targetRoot: string,
  options: BuildRunnerBundleOptions,
): Promise<RunnerBundleManifest> => {
  const entries = await bundleEntries(targetRoot);
  const unsigned = {
    compatibility: {
      architecture: "arm64" as const,
      assemblySchemaVersions: [SCHEMA_VERSION] as const,
      checkpointSchemaVersions: [RUNNER_CHECKPOINT_SCHEMA_VERSION] as const,
      platform: "linux" as const,
    },
    entries,
    format: "agent-boot-runner-bundle" as const,
    node: options.node,
    schemaVersion: RUNNER_BUNDLE_SCHEMA_VERSION,
    service: {
      ttyPath: "/dev/tty1" as const,
      unitName: RUNNER_SERVICE_NAME as "agent-boot-runner.service",
    },
  };
  return { ...unsigned, bundleSha256: sha256(canonicalJson(unsigned)) };
};

const assertSafeOutput = async (output: string): Promise<void> => {
  const parent = dirname(output);
  if (resolve(await realpath(parent)) !== resolve(parent)) {
    throw new Error("Bundle output parent must not contain symbolic links.");
  }
  try {
    await lstat(output);
    throw new Error("Bundle output already exists.");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
};

export const buildRunnerBundle = async (
  options: BuildRunnerBundleOptions,
): Promise<RunnerBundleManifest> => {
  const output = resolve(options.outputDirectory);
  await assertSafeOutput(output);
  const staging = await mkdtemp(join(dirname(output), `.${basename(output)}.staging-`));
  try {
    const targetRoot = join(staging, BUNDLE_ROOT_PATH);
    await writeTargetAssets(targetRoot, options);
    const manifest = await createManifest(targetRoot, options);
    await writeFile(join(staging, BUNDLE_MANIFEST_PATH), canonicalJson(manifest), 0o644);
    await verifyRunnerBundle(staging);
    await rename(staging, output);
    return manifest;
  } finally {
    await rm(staging, { force: true, recursive: true });
  }
};

export const targetPathForBundleEntry = (entryPath: string): string => {
  if (
    !entryPath.startsWith(`${BUNDLE_ROOT_PATH}/`) ||
    entryPath.includes("\\") || entryPath.includes("\0") ||
    normalize(entryPath) !== entryPath
  ) {
    throw new Error("Bundle entries must live beneath the bundle root.");
  }
  return `/${entryPath.slice(BUNDLE_ROOT_PATH.length + 1)}`;
};

export const bundlePathFor = bundlePathForTarget;

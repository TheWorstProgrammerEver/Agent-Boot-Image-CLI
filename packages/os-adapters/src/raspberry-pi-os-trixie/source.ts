import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { createHash } from "node:crypto";

import {
  ProtocolValidationError,
  assemblyDocumentsSchema,
  osLockSchema,
  type AssemblyDocuments,
  type OsLock,
} from "@agent-boot/protocol";
import { verifyRunnerBundle, type RunnerBundleManifest } from "@agent-boot/runner-bundle";

import { osCatalog } from "../catalog/index.js";
import { adapterError } from "./errors.js";

export interface LoadedAssembly {
  readonly documents: AssemblyDocuments;
  readonly files: ReadonlyMap<string, Uint8Array>;
}

export interface LoadedInputs {
  readonly assembly: LoadedAssembly;
  readonly bundle: RunnerBundleManifest;
  readonly osLock: OsLock;
}

const isInside = (root: string, path: string): boolean => {
  const suffix = relative(root, path);
  return suffix === "" || (!suffix.startsWith(`..${sep}`) && suffix !== ".." && !suffix.startsWith(sep));
};

export const assertSafeRoot = async (input: string): Promise<string> => {
  const root = resolve(input);
  let status;
  try {
    status = await lstat(root);
    if (!status.isDirectory() || status.isSymbolicLink() || resolve(await realpath(root)) !== root) {
      throw new Error("unsafe");
    }
  } catch {
    throw adapterError("unsafe-path", "An input root is not a safe directory.");
  }
  return root;
};

const assertSafeParents = async (root: string, path: string): Promise<void> => {
  for (let current = dirname(path); current !== root; current = dirname(current)) {
    if (!isInside(root, current)) throw adapterError("unsafe-path", "An input path escapes its root.");
    const status = await lstat(current);
    if (!status.isDirectory() || status.isSymbolicLink()) {
      throw adapterError("unsafe-path", "An input path contains an unsafe directory.");
    }
  }
};

export const readSafeFile = async (root: string, relativePath: string): Promise<Uint8Array> => {
  const path = resolve(root, relativePath);
  if (!isInside(root, path) || path === root || relativePath.includes("\\")) {
    throw adapterError("unsafe-path", "An input file path escapes its root.");
  }
  try {
    await assertSafeParents(root, path);
    const before = await lstat(path);
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) throw new Error("unsafe");
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const opened = await handle.stat();
      if (!opened.isFile() || opened.nlink !== 1 || opened.dev !== before.dev || opened.ino !== before.ino) {
        throw new Error("unsafe");
      }
      return await handle.readFile();
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (error instanceof Error && error.name === "RaspberryPiOsAdapterError") throw error;
    throw adapterError("unsafe-path", "An input file is missing or unsafe.");
  }
};

const parseJson = (bytes: Uint8Array): unknown => {
  try {
    return JSON.parse(Buffer.from(bytes).toString("utf8"));
  } catch {
    throw adapterError("invalid-input", "An assembly document is invalid.");
  }
};

const digest = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");

const loadAssembly = async (directory: string): Promise<LoadedAssembly> => {
  const root = await assertSafeRoot(directory);
  const [manifestBytes, planBytes, lockBytes] = await Promise.all([
    readSafeFile(root, "manifest.json"),
    readSafeFile(root, "runner-plan.json"),
    readSafeFile(root, "os-lock.json"),
  ]);
  let documents: AssemblyDocuments;
  try {
    documents = assemblyDocumentsSchema.parse({
      manifest: parseJson(manifestBytes),
      runnerPlan: parseJson(planBytes),
      osLock: parseJson(lockBytes),
    });
  } catch (error) {
    if (error instanceof ProtocolValidationError) {
      throw adapterError("invalid-input", "The assembly documents are incompatible.");
    }
    throw error;
  }

  const paths = new Set([
    ...documents.manifest.assets.map((asset) => asset.path),
    ...documents.manifest.prompts.map((prompt) => prompt.path),
  ]);
  const files = new Map<string, Uint8Array>([
    ["manifest.json", manifestBytes],
    ["runner-plan.json", planBytes],
    ["os-lock.json", lockBytes],
  ]);
  for (const path of [...paths].sort()) files.set(path, await readSafeFile(root, path));
  for (const asset of documents.manifest.assets) {
    const contents = files.get(asset.path);
    if (
      contents === undefined || contents.byteLength !== asset.byteLength ||
      digest(contents) !== asset.sha256
    ) throw adapterError("invalid-input", "An assembly asset failed verification.");
  }
  for (const prompt of documents.manifest.prompts) {
    const contents = files.get(prompt.path);
    if (contents === undefined || digest(contents) !== prompt.sha256) {
      throw adapterError("invalid-input", "An assembly prompt failed verification.");
    }
  }
  return { documents, files };
};

const validateCuratedLock = (input: unknown): OsLock => {
  let lock: OsLock;
  try {
    lock = osLockSchema.parse(input);
  } catch {
    throw adapterError("invalid-input", "The OS lock is invalid.");
  }
  const curated = osCatalog.resolve({
    architecture: "arm64",
    boards: ["raspberry-pi-5"],
    catalogId: "raspberry-pi-os-lite-trixie-arm64",
  });
  if (JSON.stringify(lock) !== JSON.stringify(curated)) {
    throw adapterError("incompatible-image", "The OS lock is not the curated Trixie image contract.");
  }
  return lock;
};

export const loadInputs = async (
  assemblyDirectory: string,
  bundleDirectory: string,
  osLockInput: unknown,
): Promise<LoadedInputs> => {
  const osLock = validateCuratedLock(osLockInput);
  const [assembly, bundleRoot] = await Promise.all([
    loadAssembly(assemblyDirectory),
    assertSafeRoot(bundleDirectory),
  ]);
  let bundle: RunnerBundleManifest;
  try {
    bundle = await verifyRunnerBundle(bundleRoot);
  } catch {
    throw adapterError("invalid-input", "The runner bundle failed verification.");
  }
  if (JSON.stringify(assembly.documents.osLock) !== JSON.stringify(osLock)) {
    throw adapterError("incompatible-image", "The assembly and supplied OS lock do not match.");
  }
  return { assembly, bundle, osLock };
};

export const readBundleFile = async (
  bundleDirectory: string,
  bundlePath: string,
): Promise<Uint8Array> => {
  const root = await assertSafeRoot(bundleDirectory);
  return readSafeFile(root, bundlePath);
};

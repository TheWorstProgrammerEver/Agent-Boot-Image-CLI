import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import type { AgentDefinition } from "@agent-boot/definition";

import { SynthesisError } from "./errors.js";

interface DefinitionReference {
  readonly fieldPath: string;
  readonly kind: "asset" | "prompt" | "script" | "secret";
  readonly id: string;
  readonly url: string;
}

export interface SourceFileAccess {
  readonly inspect: (path: string) => Promise<void>;
  readonly read: (path: string) => Promise<Buffer>;
}

const defaultAccess: SourceFileAccess = {
  async inspect(path) {
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink() || !metadata.isFile()) {
      throw new Error("not a regular non-symlink file");
    }
    if (await realpath(path) !== resolve(path)) throw new Error("path contains a symbolic link");
  },
  async read(path) {
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const metadata = await handle.stat();
      if (!metadata.isFile()) throw new Error("not a regular file");
      return await handle.readFile();
    } finally {
      await handle.close();
    }
  },
};

const isWithin = (root: string, path: string): boolean => {
  const suffix = relative(root, path);
  return suffix !== ".." && !suffix.startsWith(`..${sep}`) && suffix !== "";
};

const referencesFrom = (definition: AgentDefinition): DefinitionReference[] => [
  ...definition.assets.map((reference, index) => ({
    fieldPath: `$.assets[${String(index)}].source.url`,
    kind: reference.kind,
    id: reference.id,
    url: reference.source.url,
  })),
  ...definition.prompts.map((reference, index) => ({
    fieldPath: `$.prompts[${String(index)}].source.url`,
    kind: reference.kind,
    id: reference.id,
    url: reference.source.url,
  })),
  ...definition.scripts.map((reference, index) => ({
    fieldPath: `$.scripts[${String(index)}].source.url`,
    kind: reference.kind,
    id: reference.id,
    url: reference.source.url,
  })),
  ...definition.secrets.map((reference, index) => ({
    fieldPath: `$.secrets[${String(index)}].source.url`,
    kind: reference.kind,
    id: reference.id,
    url: reference.source.url,
  })),
];

export interface CollectedSourceFiles {
  readonly assets: ReadonlyMap<string, Buffer>;
  readonly prompts: ReadonlyMap<string, Buffer>;
  readonly scripts: ReadonlyMap<string, Buffer>;
}

export const collectSourceFiles = async (
  definition: AgentDefinition,
  access: SourceFileAccess = defaultAccess,
): Promise<CollectedSourceFiles> => {
  const definitionPath = fileURLToPath(definition.definitionUrl);
  const definitionRoot = dirname(definitionPath);
  const files = {
    assets: new Map<string, Buffer>(),
    prompts: new Map<string, Buffer>(),
    scripts: new Map<string, Buffer>(),
  };

  for (const reference of referencesFrom(definition)) {
    let sourcePath: string;
    try {
      sourcePath = fileURLToPath(reference.url);
    } catch {
      throw new SynthesisError(
        "unsafe-reference",
        "Expected a local file reference.",
        reference.fieldPath,
      );
    }
    const normalizedPath = resolve(sourcePath);
    if (!isWithin(definitionRoot, normalizedPath)) {
      throw new SynthesisError(
        "unsafe-reference",
        "Referenced files must remain beneath the definition root.",
        reference.fieldPath,
      );
    }
    try {
      await access.inspect(normalizedPath);
    } catch {
      throw new SynthesisError(
        "unsafe-reference",
        "Expected a regular file beneath the definition root with no symbolic links.",
        reference.fieldPath,
      );
    }
    if (reference.kind === "secret") continue;

    let contents: Buffer;
    try {
      contents = await access.read(normalizedPath);
    } catch {
      throw new SynthesisError(
        "operational",
        "A non-secret source file could not be read.",
        reference.fieldPath,
      );
    }
    files[`${reference.kind}s`].set(reference.id, contents);
  }
  return files;
};

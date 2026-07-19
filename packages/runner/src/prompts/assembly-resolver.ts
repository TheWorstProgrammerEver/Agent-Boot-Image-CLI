import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";

import type {
  AssemblyManifest,
  AssetDescriptor,
  PromptDescriptor,
} from "@agent-boot/protocol";

import { PromptHydrationError } from "./errors.js";

export interface ResolvedPromptResource {
  readonly contents: Uint8Array;
  readonly descriptor: PromptDescriptor;
}

const containedPath = (root: string, relativePath: string, prefix: string): string => {
  const segments = relativePath.split("/");
  if (
    isAbsolute(relativePath) ||
    !relativePath.startsWith(`${prefix}/`) ||
    relativePath.includes("\\") ||
    segments.some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw new PromptHydrationError("unsafe-resource");
  }
  const candidate = resolve(root, ...segments);
  const containment = relative(root, candidate);
  if (containment.startsWith("..") || isAbsolute(containment) || containment === "") {
    throw new PromptHydrationError("unsafe-resource");
  }
  return candidate;
};

const sha256 = (contents: Uint8Array): string =>
  createHash("sha256").update(contents).digest("hex");

export class AssemblyResourceResolver {
  readonly #assets: ReadonlyMap<string, AssetDescriptor>;
  readonly #prompts: ReadonlyMap<string, PromptDescriptor>;
  readonly #root: string;

  constructor(root: string, manifest: AssemblyManifest) {
    if (!isAbsolute(root)) throw new PromptHydrationError("unsafe-resource");
    this.#root = resolve(root);
    this.#assets = new Map(manifest.assets.map((asset) => [asset.id, asset]));
    this.#prompts = new Map(manifest.prompts.map((prompt) => [prompt.id, prompt]));
  }

  async resolveAsset(assetId: string): Promise<Uint8Array> {
    const descriptor = this.#assets.get(assetId);
    if (descriptor === undefined) throw new PromptHydrationError("missing-resource", assetId);
    const contents = await this.#read(descriptor.path, "assets", assetId);
    if (contents.byteLength !== descriptor.byteLength || sha256(contents) !== descriptor.sha256) {
      throw new PromptHydrationError("invalid-resource", assetId);
    }
    return contents;
  }

  async resolvePrompt(templateId: string): Promise<ResolvedPromptResource> {
    const descriptor = this.#prompts.get(templateId);
    if (descriptor === undefined) {
      throw new PromptHydrationError("missing-resource", templateId);
    }
    const contents = await this.#read(descriptor.path, "prompts", templateId);
    if (sha256(contents) !== descriptor.sha256) {
      throw new PromptHydrationError("invalid-resource", templateId);
    }
    return { contents, descriptor };
  }

  async #read(relativePath: string, prefix: string, resourceId: string): Promise<Uint8Array> {
    try {
      const rootStat = await lstat(this.#root);
      if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
        throw new PromptHydrationError("unsafe-resource", resourceId);
      }
      const candidate = containedPath(this.#root, relativePath, prefix);
      let current = this.#root;
      for (const segment of relativePath.split("/")) {
        current = join(current, segment);
        const status = await lstat(current);
        if (status.isSymbolicLink()) {
          throw new PromptHydrationError("unsafe-resource", resourceId);
        }
      }
      const handle = await open(candidate, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const status = await handle.stat();
        if (!status.isFile()) throw new PromptHydrationError("unsafe-resource", resourceId);
        return await handle.readFile();
      } finally {
        await handle.close();
      }
    } catch (error) {
      if (error instanceof PromptHydrationError) throw error;
      const code = (error as NodeJS.ErrnoException).code;
      throw new PromptHydrationError(
        code === "ENOENT" ? "missing-resource" : "unsafe-resource",
        resourceId,
      );
    }
  }
}

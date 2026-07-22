import { createHash } from "node:crypto";

import type { AssemblyFile } from "@agent-boot/assembly";
import type { AgentDefinition } from "@agent-boot/definition";
import {
  ASSEMBLY_PATHS,
  type AssetDescriptor,
  type PromptDescriptor,
} from "@agent-boot/protocol";

import { SynthesisError } from "./errors.js";
import { validatePromptTemplateVariables } from "./prompt-template-validation.js";
import type { CollectedSourceFiles } from "./source-files.js";

export const sha256 = (contents: Uint8Array): string =>
  createHash("sha256").update(contents).digest("hex");

const assetDescriptor = (
  id: string,
  path: string,
  contents: Uint8Array,
  placement?: AssetDescriptor["placement"],
): AssetDescriptor => ({
  id,
  path,
  sha256: sha256(contents),
  byteLength: contents.byteLength,
  ...(placement === undefined ? {} : { placement }),
});

const scriptAssetId = (id: string): string => {
  const candidate = `script-${id}`;
  return candidate.length <= 64
    ? candidate
    : `script-${sha256(Buffer.from(id, "utf8")).slice(0, 32)}`;
};

export interface SynthesizedResources {
  readonly assets: AssetDescriptor[];
  readonly files: AssemblyFile[];
  readonly prompts: PromptDescriptor[];
}

export const createResourceFiles = (
  definition: AgentDefinition,
  collected: CollectedSourceFiles,
): SynthesizedResources => {
  const files: AssemblyFile[] = [];
  const assets: AssetDescriptor[] = [];
  const prompts: PromptDescriptor[] = [];
  const reservedAssetIds = new Set(["runner-runtime", "runner-entrypoint"]);

  for (const [index, asset] of definition.assets.entries()) {
    if (reservedAssetIds.has(asset.id)) {
      throw new SynthesisError(
        "invalid-input",
        "Definition assets must not use reserved runner identifiers.",
        `$.assets[${String(index)}].id`,
      );
    }
    reservedAssetIds.add(asset.id);
  }
  for (const asset of definition.assets) {
    const contents = collected.assets.get(asset.id);
    if (contents === undefined) throw new SynthesisError("operational", "An asset was not collected.");
    const path = `${ASSEMBLY_PATHS.assets}/resources/${asset.id}`;
    files.push({ path, contents, mode: 0o644 });
    assets.push(assetDescriptor(asset.id, path, contents, asset.placement));
  }
  for (const [index, script] of definition.scripts.entries()) {
    const contents = collected.scripts.get(script.id);
    if (contents === undefined) throw new SynthesisError("operational", "A script was not collected.");
    const path = `${ASSEMBLY_PATHS.assets}/scripts/${script.id}`;
    const descriptorId = scriptAssetId(script.id);
    if (reservedAssetIds.has(descriptorId)) {
      throw new SynthesisError(
        "invalid-input",
        "A script identifier conflicts with another assembly asset.",
        `$.scripts[${String(index)}].id`,
      );
    }
    reservedAssetIds.add(descriptorId);
    files.push({ path, contents, mode: 0o755 });
    assets.push(assetDescriptor(
      descriptorId,
      path,
      contents,
      { scope: "system", path: `opt/agent-boot/scripts/${script.id}` },
    ));
  }
  for (const [index, prompt] of definition.prompts.entries()) {
    const contents = collected.prompts.get(prompt.id);
    if (contents === undefined) throw new SynthesisError("operational", "A prompt was not collected.");
    validatePromptTemplateVariables(prompt, contents, `$.prompts[${String(index)}].source.url`);
    const path = `${ASSEMBLY_PATHS.prompts}/${prompt.id}`;
    files.push({ path, contents, mode: 0o644 });
    prompts.push({ id: prompt.id, path, sha256: sha256(contents), variables: prompt.variables });
  }
  return { assets, files, prompts };
};

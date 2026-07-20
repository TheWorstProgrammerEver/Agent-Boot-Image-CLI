import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { canonicalJson } from "./canonical-json.js";
import { isSha256, sha256 } from "./digest.js";
import {
  RUNNER_BUNDLE_SCHEMA_VERSION,
  type RunnerBundleManifest,
} from "./model.js";
import { BUNDLE_MANIFEST_PATH, BUNDLE_ROOT_PATH } from "./paths.js";
import { bundleEntries } from "./tree.js";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const exactKeys = (value: Record<string, unknown>, keys: readonly string[]): boolean => {
  const actual = Object.keys(value).sort();
  return actual.length === keys.length && keys.slice().sort().every((key, index) => key === actual[index]);
};

const sameJson = (left: unknown, right: unknown): boolean =>
  JSON.stringify(left) === JSON.stringify(right);

const hasValidHeader = (value: Record<string, unknown>): boolean => {
  const compatibility = value.compatibility;
  const node = value.node;
  const service = value.service;
  return (
    value.schemaVersion === RUNNER_BUNDLE_SCHEMA_VERSION &&
    value.format === "agent-boot-runner-bundle" &&
    typeof value.bundleSha256 === "string" && isSha256(value.bundleSha256) &&
    isRecord(compatibility) &&
    exactKeys(compatibility, [
      "architecture", "assemblySchemaVersions", "checkpointSchemaVersions", "platform",
    ]) &&
    compatibility.architecture === "arm64" && compatibility.platform === "linux" &&
    sameJson(compatibility.assemblySchemaVersions, [1]) &&
    sameJson(compatibility.checkpointSchemaVersions, [2]) &&
    isRecord(node) &&
    exactKeys(node, ["distributionSha256", "ltsCodename", "treeSha256", "version"]) &&
    typeof node.distributionSha256 === "string" && isSha256(node.distributionSha256) &&
    typeof node.treeSha256 === "string" && isSha256(node.treeSha256) &&
    typeof node.ltsCodename === "string" && node.ltsCodename.length > 0 &&
    typeof node.version === "string" && /^v\d+\.\d+\.\d+$/u.test(node.version) &&
    isRecord(service) && exactKeys(service, ["ttyPath", "unitName"]) &&
    service.ttyPath === "/dev/tty1" && service.unitName === "agent-boot-runner.service" &&
    Array.isArray(value.entries)
  );
};

export const verifyRunnerBundle = async (
  bundleDirectory: string,
): Promise<RunnerBundleManifest> => {
  const root = resolve(bundleDirectory);
  const serialized = await readFile(join(root, BUNDLE_MANIFEST_PATH), "utf8");
  let document: unknown;
  try {
    document = JSON.parse(serialized);
  } catch {
    throw new Error("Runner bundle manifest is not valid JSON.");
  }
  if (
    !isRecord(document) ||
    !exactKeys(document, [
      "bundleSha256", "compatibility", "entries", "format", "node", "schemaVersion", "service",
    ]) ||
    !hasValidHeader(document)
  ) {
    throw new Error("Runner bundle manifest is incompatible.");
  }
  const entries = await bundleEntries(join(root, BUNDLE_ROOT_PATH));
  if (!sameJson(document.entries, entries)) {
    throw new Error("Runner bundle entries do not match the target root.");
  }
  const { bundleSha256, ...unsigned } = document;
  if (bundleSha256 !== sha256(canonicalJson(unsigned))) {
    throw new Error("Runner bundle aggregate checksum does not match.");
  }
  const manifest = document as unknown as RunnerBundleManifest;
  if (serialized !== canonicalJson(manifest)) {
    throw new Error("Runner bundle manifest is not canonical.");
  }
  return manifest;
};

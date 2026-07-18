import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { URL } from "node:url";

import {
  ASSEMBLY_PATHS,
  SCHEMA_VERSION,
  assemblyDocumentsSchema,
  manifestSchema,
  osLockSchema,
  runnerPlanSchema,
} from "../packages/protocol/dist/index.js";
import { fixtureRoot, validAssemblyDocuments } from "../test-support/protocol-fixtures.mjs";

test("valid assembly fixtures cover the canonical layout and descriptor variants", () => {
  const documents = validAssemblyDocuments();
  const parsed = assemblyDocumentsSchema.parse(documents);

  assert.equal(parsed.manifest.schemaVersion, SCHEMA_VERSION);
  assert.deepEqual(parsed.manifest.files, {
    runnerPlan: ASSEMBLY_PATHS.runnerPlan,
    osLock: ASSEMBLY_PATHS.osLock,
    assetsDirectory: ASSEMBLY_PATHS.assets,
    promptsDirectory: ASSEMBLY_PATHS.prompts,
  });

  const stepKinds = new Set(parsed.runnerPlan.steps.map((step) => step.kind));
  assert.deepEqual(stepKinds, new Set([
    "environment",
    "automatic",
    "manual",
    "fire-and-forget",
    "install-user-secret",
    "prompt",
    "provider",
  ]));
  assert.deepEqual(
    parsed.runnerPlan.steps
      .filter((step) => step.kind === "environment")
      .map((step) => step.operation),
    ["set", "unset"],
  );
  const prompt = parsed.runnerPlan.steps.find((step) => step.kind === "prompt");
  assert.deepEqual(prompt.variables.map((binding) => binding.source.kind), [
    "environment",
    "secret",
  ]);
});

test("fixture asset and prompt digests match their manifest descriptors", () => {
  const { manifest } = validAssemblyDocuments();
  for (const descriptor of [...manifest.assets, ...manifest.prompts]) {
    const contents = readFileSync(new URL(descriptor.path, fixtureRoot));
    assert.equal(createHash("sha256").update(contents).digest("hex"), descriptor.sha256);
    if ("byteLength" in descriptor) assert.equal(contents.byteLength, descriptor.byteLength);
  }
});

test("each serialized boundary survives a JSON round trip", () => {
  const documents = validAssemblyDocuments();
  const cases = [
    [manifestSchema, documents.manifest],
    [runnerPlanSchema, documents.runnerPlan],
    [osLockSchema, documents.osLock],
  ];
  for (const [schema, fixture] of cases) {
    const parsed = schema.parse(fixture);
    assert.deepEqual(JSON.parse(JSON.stringify(parsed)), parsed);
    assert.deepEqual(schema.parse(JSON.parse(JSON.stringify(parsed))), parsed);
  }
});

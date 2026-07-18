import assert from "node:assert/strict";
import test from "node:test";

import {
  ProtocolValidationError,
  SchemaCompatibilityError,
  assertCompatibleSchemaVersion,
  manifestSchema,
  osLockSchema,
  runnerPlanSchema,
} from "../packages/protocol/dist/index.js";
import { clone, validAssemblyDocuments } from "../test-support/protocol-fixtures.mjs";

const rejects = (schema, value, pattern) => {
  assert.throws(
    () => schema.parse(value),
    (error) => error instanceof ProtocolValidationError && pattern.test(error.message),
  );
};

test("all document schemas reject missing, unknown, and incompatible versions", () => {
  const documents = validAssemblyDocuments();
  for (const [schema, fixture] of [
    [manifestSchema, documents.manifest],
    [runnerPlanSchema, documents.runnerPlan],
    [osLockSchema, documents.osLock],
  ]) {
    const future = clone(fixture);
    future.schemaVersion = 2;
    rejects(schema, future, /schemaVersion.*Expected 1/);

    const missing = clone(fixture);
    delete missing.schemaVersion;
    rejects(schema, missing, /schemaVersion.*Required field is missing/);

    const unknown = clone(fixture);
    unknown.futureField = true;
    rejects(schema, unknown, /futureField.*Unknown field/);
  }
});

test("CLI and runner compatibility negotiation fails closed with recovery guidance", () => {
  for (const consumer of ["Agent Boot CLI", "Agent Boot runner"]) {
    assert.throws(
      () => assertCompatibleSchemaVersion(consumer, "runner-plan.json", 2),
      (error) =>
        error instanceof SchemaCompatibilityError &&
        error.message.includes(consumer) &&
        error.message.includes("Supported versions: 1") &&
        error.message.includes("Regenerate the assembly") &&
        error.message.includes("update the consuming runner/CLI"),
    );
  }
  assert.throws(
    () => assertCompatibleSchemaVersion("Agent Boot runner", "manifest.json", undefined),
    /schema version missing/,
  );
  assert.equal(assertCompatibleSchemaVersion("Agent Boot runner", "manifest.json", 1), 1);
});

test("bootstrap and ordered runner data cannot cross their schema boundaries", () => {
  const { manifest, runnerPlan } = validAssemblyDocuments();
  const manifestWithSteps = clone(manifest);
  manifestWithSteps.steps = [];
  rejects(manifestSchema, manifestWithSteps, /steps.*Unknown field/);

  const assetWithUnknownField = clone(manifest);
  assetWithUnknownField.assets[0].futurePlacementMode = "copy";
  rejects(manifestSchema, assetWithUnknownField, /futurePlacementMode.*Unknown field/);

  const planWithBootstrap = clone(runnerPlan);
  planWithBootstrap.bootstrap = {};
  rejects(runnerPlanSchema, planWithBootstrap, /bootstrap.*Unknown field/);
});

test("paths, identifiers, environment keys, digests, and URLs are validated", () => {
  const { manifest, runnerPlan, osLock } = validAssemblyDocuments();

  const traversal = clone(manifest);
  traversal.assets[0].path = "assets/../credential.txt";
  rejects(manifestSchema, traversal, /normalized relative path/);

  const absoluteDestination = clone(runnerPlan);
  absoluteDestination.steps[5].destination = "/home/reviewer/key";
  rejects(runnerPlanSchema, absoluteDestination, /normalized relative path/);

  const invalidKey = clone(runnerPlan);
  invalidKey.steps[0].key = "AGENT-NAME";
  rejects(runnerPlanSchema, invalidKey, /portable environment key/);

  const invalidId = clone(manifest);
  invalidId.agent.id = "Reviewer Agent";
  rejects(manifestSchema, invalidId, /lowercase identifier/);

  const invalidDigest = clone(osLock);
  invalidDigest.artifact.sha256 = "D".repeat(64);
  rejects(osLockSchema, invalidDigest, /lowercase SHA-256/);

  const insecureUrl = clone(osLock);
  insecureUrl.artifact.url = "http://example.invalid/image.img";
  rejects(osLockSchema, insecureUrl, /absolute HTTPS URL/);

  const credentialUrl = clone(osLock);
  credentialUrl.artifact.url = "https://user:password@example.invalid/image.img";
  rejects(osLockSchema, credentialUrl, /without embedded credentials/);
});

test("plaintext credential fields and non-public environment keys are rejected", () => {
  const { manifest, runnerPlan } = validAssemblyDocuments();

  const accountPassword = clone(manifest);
  accountPassword.bootstrap.account.password = "not-a-real-password";
  rejects(manifestSchema, accountPassword, /Plaintext credential fields are not permitted/);

  const secretValue = clone(manifest);
  secretValue.bootstrap.account.initialPassword.value = "not-a-real-password";
  rejects(manifestSchema, secretValue, /value.*Unknown field/);

  const wifiPassphrase = clone(manifest);
  wifiPassphrase.bootstrap.network.wifi.passphrase = "not-a-real-passphrase";
  rejects(manifestSchema, wifiPassphrase, /passphrase.*Expected an object/);

  const planCredentials = clone(runnerPlan);
  planCredentials.credentials = { token: "not-a-real-token" };
  rejects(runnerPlanSchema, planCredentials, /Plaintext credential fields are not permitted/);

  const commandToken = clone(runnerPlan);
  commandToken.providers[0].command.token = "not-a-real-token";
  rejects(runnerPlanSchema, commandToken, /Plaintext credential fields are not permitted/);

  for (const key of [
    "PGPASSWORD",
    "GITHUB_API_TOKEN",
    "GITHUB_PAT",
    "DATABASE_URL",
    "CUSTOM_CONFIG",
  ]) {
    const nonPublicEnvironment = clone(runnerPlan);
    nonPublicEnvironment.steps[0].key = key;
    rejects(
      runnerPlanSchema,
      nonPublicEnvironment,
      /explicitly permitted public environment key/,
    );
  }

  const promptEnvironment = clone(runnerPlan);
  promptEnvironment.steps
    .find((step) => step.kind === "prompt")
    .variables.find((variable) => variable.source.kind === "environment").source.key =
    "DATABASE_URL";
  rejects(
    runnerPlanSchema,
    promptEnvironment,
    /explicitly permitted public environment key/,
  );
});

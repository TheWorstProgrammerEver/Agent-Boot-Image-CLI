import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { URL } from "node:url";

import { agentDefinitionSchema } from "../packages/definition/dist/index.js";
import { runnerPlanSchema } from "../packages/protocol/dist/index.js";

const root = new URL("../", import.meta.url);
const definitionFixturePath =
  "packages/definition/fixtures/definitive-agent/canonical-definition.json";
const runnerPlanFixturePath =
  "packages/protocol/fixtures/definitive-agent/runner-plan.json";
const provenancePath =
  "packages/definition/fixtures/definitive-agent/provenance.json";
const examplePaths = [
  "examples/definitive-agent/definition.ts",
  "examples/definitive-agent/prompts/bootstrap-agent.md",
  "examples/definitive-agent/README.md",
];

const read = (path) => readFileSync(new URL(path, root), "utf8");
const canonicalJson = (value) => `${JSON.stringify(value, null, 2)}\n`;
const sha256 = (value) => createHash("sha256").update(value).digest("hex");

test("definitive fixtures conform to both canonical runtime schemas", () => {
  const definition = agentDefinitionSchema.parse(JSON.parse(read(definitionFixturePath)));
  const runnerPlan = runnerPlanSchema.parse(JSON.parse(read(runnerPlanFixturePath)));

  assert.equal(runnerPlan.agentId, definition.agent.id);
  assert.deepEqual(runnerPlan.providers, definition.providers);
  assert.deepEqual(runnerPlan.steps, definition.steps);
  assert.deepEqual(
    definition.steps.map((step) => step.kind),
    [
      "environment",
      "environment",
      "automatic",
      "automatic",
      "automatic",
      "manual",
      "fire-and-forget",
      "install-user-secret",
      "environment",
      "prompt",
      "provider",
    ],
  );
  assert.deepEqual(
    definition.steps
      .filter((step) => step.kind === "environment")
      .map((step) => step.operation),
    ["set", "set", "unset"],
  );
});

test("Codex bootstrap gates provider execution in declared order", () => {
  const definition = agentDefinitionSchema.parse(JSON.parse(read(definitionFixturePath)));
  const stepIds = definition.steps.map((step) => step.id);
  const indexOf = (id) => {
    const index = stepIds.indexOf(id);
    assert.notEqual(index, -1, `Missing step ${id}.`);
    return index;
  };

  assert.ok(indexOf("install-codex") < indexOf("configure-codex-yolo-profile"));
  assert.ok(indexOf("configure-codex-yolo-profile") < indexOf("verify-codex-yolo-profile"));
  assert.ok(indexOf("verify-codex-yolo-profile") < indexOf("authenticate-codex"));
  assert.ok(indexOf("authenticate-codex") < indexOf("render-bootstrap-prompt"));
  assert.ok(indexOf("render-bootstrap-prompt") < indexOf("run-codex-bootstrap"));

  const provider = definition.providers[0];
  assert.deepEqual(provider.command.workingDirectory, {
    scope: "user-home",
    path: "workspace",
  });
});

test("fixtures serialize deterministically and match recorded provenance hashes", () => {
  const provenance = JSON.parse(read(provenancePath));
  const schemas = new Map([
    [definitionFixturePath, agentDefinitionSchema],
    [runnerPlanFixturePath, runnerPlanSchema],
  ]);

  for (const { path, sha256: expected } of provenance.fixtures) {
    const serialized = read(path);
    const schema = schemas.get(path);
    assert.ok(schema, `Missing canonical schema for ${path}.`);
    assert.equal(serialized, canonicalJson(schema.parse(JSON.parse(serialized))));
    assert.equal(sha256(serialized), expected);
  }
  assert.equal(
    provenance.authoritativeScratchpad.sha256,
    "a01b0dc74eb90207c790d0cbd6a59d5e552455f330848cd1755a59f19ad0fac4",
  );
  assert.equal(provenance.derivation.sensitiveContentsEmbedded, false);
});

test("example and fixtures retain only role-based identities and opaque secret references", () => {
  const definition = agentDefinitionSchema.parse(JSON.parse(read(definitionFixturePath)));
  const serialized = read(definitionFixturePath);

  assert.equal(definition.agent.id, "my-agent");
  assert.equal(definition.account.username, "my-user");
  assert.equal(definition.network.wifi.ssid, "<network-ssid>");
  assert.deepEqual(
    definition.secrets.map((entry) => entry.id),
    ["account-authentication", "network-authentication", "repository-credential"],
  );
  assert.ok(definition.secrets.every((entry) =>
    Object.keys(entry).join(",") === "kind,id,source"));
  assert.doesNotMatch(
    serialized,
    /secretValue|credentialValue|materialized|privateKey|-----BEGIN/u,
  );
});

test("example sources pass credential and local-identity pattern scans", () => {
  const contents = [
    ...examplePaths.map(read),
    read(definitionFixturePath),
    read(runnerPlanFixturePath),
  ].join("\n");
  const forbiddenPatterns = [
    /-----BEGIN [A-Z ]*PRIVATE KEY-----/u,
    /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/u,
    /\bgh[pousr]_[A-Za-z0-9]{20,}\b/u,
    /\bsk-[A-Za-z0-9]{20,}\b/u,
    /\b(?:id_rsa|id_ed25519|[^/\s]+\.(?:pem|p12|key))\b/iu,
    /\b(?:daedalus|momus|maximus|mnemosyne|codex-agent)\b/iu,
  ];

  for (const pattern of forbiddenPatterns) assert.doesNotMatch(contents, pattern);
  assert.match(contents, /<network-ssid>/u);
  assert.match(contents, /<reviewed-version>/u);
});

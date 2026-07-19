import assert from "node:assert/strict";
import test from "node:test";

import { secret } from "@agent-boot/definition";
import { codexProvider } from "@agent-boot/definition/providers/codex";

const workingRoot = { path: "workspace", scope: "user-home" };

test("manual Codex bootstrap is pinned, ordered, explicit, and permission-complete", () => {
  const slice = codexProvider({
    authentication: { kind: "manual-device-auth", pollIntervalSeconds: 3 },
    version: "1.2.3",
    workingRoot,
  });

  assert.deepEqual(
    slice.bootstrapSteps.map(step => [step.id, step.kind]),
    [
      ["codex-install", "automatic"],
      ["codex-verify-version", "automatic"],
      ["codex-configure-profile", "automatic"],
      ["codex-verify-profile", "automatic"],
      ["codex-authenticate-device", "manual"],
    ],
  );
  assert.deepEqual(slice.bootstrapSteps[0].command.arguments, [
    "install", "--global", "@openai/codex@1.2.3",
  ]);
  assert.deepEqual(slice.bootstrapSteps[1].command.arguments, [
    "verify-version", "--expected", "1.2.3",
  ]);
  assert.deepEqual(slice.bootstrapSteps[4].command.arguments, ["login", "--device-auth"]);
  assert.deepEqual(slice.bootstrapSteps[4].completionCheck.arguments, ["login", "status"]);
  assert.equal(slice.bootstrapSteps[4].pollIntervalSeconds, 3);
  assert.ok(slice.bootstrapSteps.every(step =>
    step.kind === "install-user-secret" ||
    step.command.workingDirectory === workingRoot));
  assert.equal(slice.provider.command.workingDirectory, workingRoot);
  assert.deepEqual(slice.provider.command.arguments, [
    "exec", "--profile", "agent-boot", "--strict-config",
    "--sandbox", "danger-full-access", "--ask-for-approval", "never", "-",
  ]);
});

test("automatic Codex credentials are a typed secret install followed by an auth gate", () => {
  const credential = secret("codex-credentials", "./secrets/codex-auth.json");
  const slice = codexProvider({
    authentication: { credential, kind: "automatic-credentials" },
    id: "primary-codex",
    version: "2.0.0-rc.1",
    workingRoot,
  });

  assert.deepEqual(
    slice.bootstrapSteps.slice(-2).map(step => [step.id, step.kind]),
    [
      ["primary-codex-install-credentials", "install-user-secret"],
      ["primary-codex-verify-authentication", "automatic"],
    ],
  );
  assert.equal(slice.bootstrapSteps.at(-2).destination, ".codex/auth.json");
  assert.equal(slice.bootstrapSteps.at(-2).secret, credential);
  assert.deepEqual(slice.bootstrapSteps.at(-1).command.arguments, ["login", "status"]);
  const serialized = JSON.stringify(slice);
  assert.doesNotMatch(serialized, /contents|token|password|api.key/iu);
});

test("Codex sources reject mutable npm selectors before definition synthesis", () => {
  for (const version of [
    "latest", "^1.2.3", "1.2", "v1.2.3", "01.2.3", "1.2.3-01", "1.2.3 || 2.0.0",
  ]) {
    assert.throws(
      () => codexProvider({
        authentication: { kind: "manual-device-auth" },
        version,
        workingRoot,
      }),
      /exact semver/u,
    );
  }
});

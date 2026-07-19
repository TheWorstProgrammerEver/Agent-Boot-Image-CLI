import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  access,
  chmod,
  link,
  lstat,
  mkdir,
  readFile,
  rm,
  stat,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import {
  NodeUserSecretFileSystem,
  RunnerEngine,
  RunnerPlanError,
} from "@agent-boot/runner";

import { serializePlan } from "../test-support/runner-engine-helpers.mjs";
import {
  createUserSecretFixture,
  secretContents,
  userSecretStep,
} from "../test-support/runner-user-secret-helpers.mjs";

const execFileAsync = promisify(execFile);

const absent = async path => {
  await assert.rejects(access(path), error => error.code === "ENOENT");
};

const privateMode = async path => (await stat(path)).mode & 0o777;

test("installs, verifies, removes, and idempotently checkpoints a user secret", async () => {
  const progress = [];
  const fixture = await createUserSecretFixture({
    engineOptions: { onProgress: event => progress.push(event) },
  });
  const orphan = join(dirname(fixture.destination), ".credential.abandoned.tmp");
  try {
    await mkdir(dirname(fixture.destination), { recursive: true });
    await writeFile(orphan, secretContents, { mode: 0o600 });
    const result = await fixture.engine.run();

    assert.equal(result.status, "succeeded");
    assert.deepEqual(await readFile(fixture.destination), secretContents);
    await absent(fixture.source);
    await absent(orphan);
    assert.equal(await privateMode(dirname(fixture.destination)), 0o700);
    assert.equal(await privateMode(fixture.destination), 0o600);
    const destinationStatus = await stat(fixture.destination);
    assert.equal(destinationStatus.uid, fixture.accountUid);
    assert.equal(destinationStatus.gid, fixture.accountGid);
    assert.equal(destinationStatus.nlink, 1);
    assert.equal(result.state.secretTransaction.phase, "committed");
    assert.deepEqual(
      progress.find(event => event.status === "secret-source-removed"),
      {
        deletionAssurance: "unlink-not-secure-erase",
        index: 0,
        status: "secret-source-removed",
        stepId: fixture.step.id,
      },
    );

    const observable = JSON.stringify({
      plan: fixture.serializedPlan,
      progress,
      state: await readFile(fixture.statePath, "utf8"),
    });
    assert.doesNotMatch(observable, /private fixture credential/u);
    assert.doesNotMatch(observable, /bootstrap-secrets/u);
    assert.doesNotMatch(observable, /contents|stdout|stderr|message/u);

    const resumed = await fixture.createEngine().run();
    assert.equal(resumed.status, "succeeded");
    assert.deepEqual(await readFile(fixture.destination), secretContents);
    await absent(fixture.source);
  } finally {
    await fixture.cleanup();
  }
});

test("rejects destination traversal before touching the temp-root filesystem", async () => {
  const destinations = [
    "/outside",
    "../outside",
    ".config/../outside",
    ".config//credential",
    ".config/credential/",
    ".config\\credential",
  ];
  for (const destination of destinations) {
    const fixture = await createUserSecretFixture();
    try {
      const document = JSON.parse(serializePlan([userSecretStep({ destination })]));
      assert.throws(
        () => fixture.createEngine({ serializedPlan: JSON.stringify(document) }),
        RunnerPlanError,
      );
      assert.deepEqual(await readFile(fixture.source), secretContents);
      await absent(fixture.destination);
    } finally {
      await fixture.cleanup();
    }
  }
});

test("rejects symlink, hardlink, and special bootstrap sources", async t => {
  await t.test("symlinked bootstrap directory", async () => {
    const fixture = await createUserSecretFixture();
    const outside = join(fixture.root, "bootstrap-outside");
    try {
      await mkdir(outside);
      await writeFile(join(outside, "service-credential"), secretContents);
      await rm(fixture.bootstrap, { recursive: true });
      await symlink(outside, fixture.bootstrap);
      const result = await fixture.engine.run();
      assert.equal(result.status, "failed");
      assert.deepEqual(
        await readFile(join(outside, "service-credential")),
        secretContents,
      );
      await absent(fixture.destination);
    } finally {
      await fixture.cleanup();
    }
  });

  await t.test("symlink", async () => {
    const fixture = await createUserSecretFixture();
    const target = join(fixture.root, "symlink-target");
    try {
      await writeFile(target, secretContents);
      await unlink(fixture.source);
      await symlink(target, fixture.source);
      const result = await fixture.engine.run();
      assert.equal(result.status, "failed");
      assert.deepEqual(await readFile(target), secretContents);
      await absent(fixture.destination);
    } finally {
      await fixture.cleanup();
    }
  });

  await t.test("hardlink", async () => {
    const fixture = await createUserSecretFixture();
    const other = join(fixture.root, "hardlink-copy");
    try {
      await link(fixture.source, other);
      const result = await fixture.engine.run();
      assert.equal(result.status, "failed");
      assert.equal((await lstat(fixture.source)).nlink, 2);
      assert.deepEqual(await readFile(other), secretContents);
      await absent(fixture.destination);
    } finally {
      await fixture.cleanup();
    }
  });

  await t.test("special file", async () => {
    const fixture = await createUserSecretFixture();
    try {
      await unlink(fixture.source);
      await execFileAsync("mkfifo", [fixture.source]);
      const result = await fixture.engine.run();
      assert.equal(result.status, "failed");
      assert.equal((await lstat(fixture.source)).isFIFO(), true);
      await absent(fixture.destination);
    } finally {
      await fixture.cleanup();
    }
  });
});

test("rejects a destination symlink without writing outside the account home", async () => {
  const fixture = await createUserSecretFixture();
  const outside = join(fixture.root, "outside");
  try {
    await mkdir(outside);
    await symlink(outside, join(fixture.home, ".config"));

    const result = await fixture.engine.run();

    assert.equal(result.status, "failed");
    assert.deepEqual(await readFile(fixture.source), secretContents);
    await absent(join(outside, "service", "credential"));
  } finally {
    await fixture.cleanup();
  }
});

const interruptionStages = [
  "before-prepared-checkpoint",
  "after-prepared-checkpoint",
  "before-install",
  "after-install",
  "before-installed-checkpoint",
  "after-installed-checkpoint",
  "before-source-remove",
  "after-source-remove",
  "before-source-removed-checkpoint",
  "after-source-removed-checkpoint",
  "before-committed-checkpoint",
  "after-committed-checkpoint",
];

test("every transaction interruption boundary recovers after reboot", async t => {
  for (const interruptionStage of interruptionStages) {
    await t.test(interruptionStage, async () => {
      const fixture = await createUserSecretFixture();
      try {
        let state = await fixture.store.initialize(fixture.identity);
        state = await fixture.store.checkpointStep(fixture.identity, {
          attempt: 1,
          id: fixture.step.id,
          index: 0,
          phase: "started",
        });
        let interrupted = false;
        const executor = fixture.createExecutor({
          lifecycle: {
            notify: stage => {
              if (!interrupted && stage === interruptionStage) {
                interrupted = true;
                throw new Error("simulated reboot");
              }
            },
          },
        });
        await assert.rejects(
          executor.execute(
            fixture.step,
            state.secretTransaction,
            checkpoint =>
              fixture.store.checkpointSecretTransaction(fixture.identity, checkpoint),
          ),
          /simulated reboot/u,
        );
        assert.equal(interrupted, true);

        const inspection = await fixture.store.inspect(fixture.identity);
        assert.equal(inspection.status, "valid");
        state = inspection.state;
        await fixture.createExecutor().execute(
          fixture.step,
          state.secretTransaction,
          checkpoint => fixture.store.checkpointSecretTransaction(fixture.identity, checkpoint),
        );
        const succeeded = await fixture.store.checkpointStep(fixture.identity, {
          attempt: 1,
          id: fixture.step.id,
          index: 0,
          phase: "succeeded",
        });

        assert.equal(succeeded.secretTransaction.phase, "committed");
        assert.deepEqual(await readFile(fixture.destination), secretContents);
        await absent(fixture.source);
        const names = await import("node:fs/promises").then(({ readdir }) =>
          readdir(dirname(fixture.destination)),
        );
        assert.equal(names.some(name => name.endsWith(".tmp")), false);
      } finally {
        await fixture.cleanup();
      }
    });
  }
});

class RenameThenInterruptFileSystem extends NodeUserSecretFileSystem {
  interrupted = false;

  async rename(from, to) {
    await super.rename(from, to);
    if (!this.interrupted && to.endsWith("/credential")) {
      this.interrupted = true;
      throw new Error("simulated rename interruption");
    }
  }
}

test("an interruption immediately after atomic rename leaves a recoverable destination", async () => {
  const fileSystem = new RenameThenInterruptFileSystem();
  const fixture = await createUserSecretFixture({
    engineOptions: { automaticPolicy: { maxAttempts: 2, timeoutMs: 1_000 } },
    userSecretInstallation: { fileSystem },
  });
  try {
    const result = await fixture.engine.run();

    assert.equal(fileSystem.interrupted, true);
    assert.equal(result.status, "succeeded");
    assert.deepEqual(await readFile(fixture.destination), secretContents);
    await absent(fixture.source);
    assert.equal(result.state.currentStep.attempt, 2);
  } finally {
    await fixture.cleanup();
  }
});

test("destination verification catches mode drift without deleting the source", async () => {
  const fixture = await createUserSecretFixture();
  try {
    let state = await fixture.store.initialize(fixture.identity);
    state = await fixture.store.checkpointStep(fixture.identity, {
      attempt: 1,
      id: fixture.step.id,
      index: 0,
      phase: "started",
    });
    const executor = fixture.createExecutor({
      lifecycle: {
        notify: stage => {
          if (stage === "after-installed-checkpoint") throw new Error("pause after install");
        },
      },
    });
    await assert.rejects(
      executor.execute(
        fixture.step,
        state.secretTransaction,
        checkpoint => fixture.store.checkpointSecretTransaction(fixture.identity, checkpoint),
      ),
      /pause after install/u,
    );
    await chmod(fixture.destination, 0o644);
    const inspection = await fixture.store.inspect(fixture.identity);
    assert.equal(inspection.status, "valid");
    await assert.rejects(
      fixture.createExecutor().execute(
        fixture.step,
        inspection.state.secretTransaction,
        checkpoint => fixture.store.checkpointSecretTransaction(fixture.identity, checkpoint),
      ),
      /verification-failed/u,
    );
    assert.deepEqual(await readFile(fixture.source), secretContents);
  } finally {
    await fixture.cleanup();
  }
});

test("an install-user-secret plan is unsupported unless account ownership is configured", async () => {
  const fixture = await createUserSecretFixture();
  try {
    const engine = new RunnerEngine({
      automaticPolicy: { maxAttempts: 1, timeoutMs: 1_000 },
      commandHost: { spawn: () => assert.fail("must not spawn") },
      environment: {
        basePath: "/usr/bin",
        homeDirectory: fixture.home,
        workingDirectory: fixture.home,
      },
      fireAndForgetPolicy: {
        acceptanceWindowMs: 10,
        maxLaunchAttempts: 1,
        terminationGraceMs: 100,
      },
      manualPolicy: {
        completionCheckTimeoutMs: 1_000,
        maximumPollIntervalMs: 1_000,
      },
      serializedPlan: fixture.serializedPlan,
      stateStore: fixture.store,
    });
    const result = await engine.run();
    assert.equal(result.status, "failed");
    assert.equal(result.state.currentStep, null);
    assert.deepEqual(await readFile(fixture.source), secretContents);
    await absent(fixture.destination);
  } finally {
    await fixture.cleanup();
  }
});

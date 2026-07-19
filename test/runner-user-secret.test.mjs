import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  access,
  chmod,
  link,
  lstat,
  mkdir,
  readFile,
  rename,
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
  const orphan = join(
    dirname(fixture.destination),
    ".credential.4c6566a8-8177-4a77-b9c1-9f3aec249d4c.tmp",
  );
  const unrelated = join(dirname(fixture.destination), ".credential.user-backup.tmp");
  const suspiciousTarget = join(fixture.root, "suspicious-temp-target");
  const suspicious = join(
    dirname(fixture.destination),
    ".credential.73dcae43-7d1f-4388-8c0d-e77a8677f28f.tmp",
  );
  try {
    await mkdir(dirname(fixture.destination), { recursive: true });
    await writeFile(orphan, secretContents, { mode: 0o600 });
    await writeFile(unrelated, "keep me\n", { mode: 0o600 });
    await writeFile(suspiciousTarget, "keep this too\n", { mode: 0o600 });
    await symlink(suspiciousTarget, suspicious);
    const result = await fixture.engine.run();

    assert.equal(result.status, "succeeded");
    assert.deepEqual(await readFile(fixture.destination), secretContents);
    await absent(fixture.source);
    await absent(orphan);
    assert.equal(await readFile(unrelated, "utf8"), "keep me\n");
    assert.equal((await lstat(suspicious)).isSymbolicLink(), true);
    assert.equal(await readFile(suspiciousTarget, "utf8"), "keep this too\n");
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

class SwapDestinationTemporaryFileSystem extends NodeUserSecretFileSystem {
  outside;
  swapped = false;

  configure(outside) {
    this.outside = outside;
  }

  async openAt(directory, name, flags, mode) {
    const handle = await super.openAt(directory, name, flags, mode);
    if (!this.swapped && /^\.credential\..+\.tmp$/u.test(name)) {
      const entry = `/proc/self/fd/${String(directory.descriptor)}/${name}`;
      await unlink(entry);
      await symlink(this.outside, entry);
      this.swapped = true;
    }
    return handle;
  }
}

test("a destination-temp symlink swap cannot redirect privileged mutations", async () => {
  const fileSystem = new SwapDestinationTemporaryFileSystem();
  const fixture = await createUserSecretFixture({
    userSecretInstallation: { fileSystem },
  });
  const outside = join(fixture.root, "outside-file");
  try {
    await writeFile(outside, "outside\n", { mode: 0o644 });
    fileSystem.configure(outside);

    const before = await stat(outside);
    const result = await fixture.engine.run();
    const after = await stat(outside);

    assert.equal(fileSystem.swapped, true);
    assert.equal(result.status, "failed");
    assert.equal(after.mode & 0o777, before.mode & 0o777);
    assert.equal(after.uid, before.uid);
    assert.equal(after.gid, before.gid);
    assert.equal(await readFile(outside, "utf8"), "outside\n");
    assert.deepEqual(await readFile(fixture.source), secretContents);
  } finally {
    await fixture.cleanup();
  }
});

class SwapDestinationDirectoryFileSystem extends NodeUserSecretFileSystem {
  accountComponent;
  displacedComponent;
  outside;
  swapped = false;

  configure({ accountComponent, displacedComponent, outside }) {
    this.accountComponent = accountComponent;
    this.displacedComponent = displacedComponent;
    this.outside = outside;
  }

  async openAt(directory, name, flags, mode) {
    const handle = await super.openAt(directory, name, flags, mode);
    if (!this.swapped && name === ".config") {
      await rename(this.accountComponent, this.displacedComponent);
      await symlink(this.outside, this.accountComponent);
      this.swapped = true;
    }
    return handle;
  }
}

test("a destination-directory symlink swap cannot redirect privileged mutations", async () => {
  const fileSystem = new SwapDestinationDirectoryFileSystem();
  const fixture = await createUserSecretFixture({
    userSecretInstallation: { fileSystem },
  });
  const accountComponent = join(fixture.home, ".config");
  const displacedComponent = join(fixture.home, ".config-displaced");
  const outside = join(fixture.root, "outside");
  try {
    await mkdir(accountComponent, { mode: 0o700 });
    await mkdir(outside, { mode: 0o755 });
    fileSystem.configure({ accountComponent, displacedComponent, outside });

    const before = await stat(outside);
    const result = await fixture.engine.run();
    const after = await stat(outside);

    assert.equal(fileSystem.swapped, true);
    assert.equal(result.status, "failed");
    assert.equal(after.mode & 0o777, before.mode & 0o777);
    assert.equal(after.uid, before.uid);
    assert.equal(after.gid, before.gid);
    assert.deepEqual(await readFile(fixture.source), secretContents);
    await absent(join(outside, "service", "credential"));
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

class SwapBootstrapDirectoryBeforeUnlinkFileSystem extends NodeUserSecretFileSystem {
  bootstrap;
  displacedBootstrap;
  outside;
  source;
  sourceStatusChecks = 0;
  swapped = false;

  configure({ bootstrap, displacedBootstrap, outside, source }) {
    this.bootstrap = bootstrap;
    this.displacedBootstrap = displacedBootstrap;
    this.outside = outside;
    this.source = source;
  }

  async lstat(path) {
    const status = await super.lstat(path);
    if (path === this.source) await this.maybeSwap();
    return status;
  }

  async lstatAt(directory, name) {
    const status = await super.lstatAt(directory, name);
    if (name === "service-credential") await this.maybeSwap();
    return status;
  }

  async maybeSwap() {
    this.sourceStatusChecks += 1;
    if (this.sourceStatusChecks !== 4) return;
    await rename(this.bootstrap, this.displacedBootstrap);
    await symlink(this.outside, this.bootstrap);
    this.swapped = true;
  }
}

test("a bootstrap-directory swap cannot redirect source deletion", async () => {
  const fileSystem = new SwapBootstrapDirectoryBeforeUnlinkFileSystem();
  const fixture = await createUserSecretFixture({
    userSecretInstallation: { fileSystem },
  });
  const displacedBootstrap = join(fixture.root, "bootstrap-displaced");
  const outside = join(fixture.root, "bootstrap-outside");
  const outsideSource = join(outside, "service-credential");
  try {
    await mkdir(outside);
    await writeFile(outsideSource, "outside source must survive\n", { mode: 0o600 });
    fileSystem.configure({
      bootstrap: fixture.bootstrap,
      displacedBootstrap,
      outside,
      source: fixture.source,
    });

    const result = await fixture.engine.run();

    assert.equal(fileSystem.swapped, true);
    assert.equal(result.status, "succeeded");
    assert.equal(await readFile(outsideSource, "utf8"), "outside source must survive\n");
    await absent(join(displacedBootstrap, "service-credential"));
    assert.deepEqual(await readFile(fixture.destination), secretContents);
  } finally {
    await fixture.cleanup();
  }
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

  async renameAt(directory, from, to) {
    await super.renameAt(directory, from, to);
    if (!this.interrupted && to === "credential") {
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

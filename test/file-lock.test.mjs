import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import { acquireFileLock } from "../packages/cli/dist/images/file-lock.js";

test("empty primary and recovery locks are reclaimed", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-boot-file-lock-"));
  const path = join(root, "artifact.lock");
  try {
    await writeFile(path, "", { mode: 0o600 });
    await writeFile(`${path}.recovery`, "", { mode: 0o600 });

    const release = await acquireFileLock(path, 100, 1);
    assert.notEqual(await readFile(path, "utf8"), "");
    await release();

    await assert.rejects(access(path), { code: "ENOENT" });
    await assert.rejects(access(`${path}.recovery`), { code: "ENOENT" });
    await assert.rejects(access(`${path}.recovery.recovery`), { code: "ENOENT" });
    assert.deepEqual(await readdir(root), []);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("a reused PID does not keep an abandoned lock alive", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-boot-file-lock-"));
  const path = join(root, "artifact.lock");
  try {
    const releaseOriginal = await acquireFileLock(path, 100, 1);
    const originalOwner = JSON.parse(await readFile(path, "utf8"));
    await releaseOriginal();

    await writeFile(path, `${JSON.stringify({
      ...originalOwner,
      startTimeTicks: originalOwner.startTimeTicks === "1" ? "2" : "1",
      token: "abandoned-owner-token",
    })}\n`, { mode: 0o600 });

    const releaseRecovered = await acquireFileLock(path, 100, 1);
    await releaseRecovered();
    await assert.rejects(access(path), { code: "ENOENT" });
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("simultaneous stale-lock recovery admits only one holder", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-boot-file-lock-"));
  const path = join(root, "locks", "artifact.lock");
  try {
    await mkdir(join(root, "locks"));

    for (let iteration = 0; iteration < 250; iteration += 1) {
      await writeFile(path, `2147483647:${String(iteration)}\n`, { mode: 0o600 });
      let entered = 0;
      const acquire = () => acquireFileLock(path, 2_000, 1).then(release => {
        entered += 1;
        return release;
      });
      const contenders = [acquire(), acquire()];
      const firstRelease = await Promise.race(contenders);

      try {
        await delay(1);
        assert.equal(entered, 1, `iteration ${String(iteration)} admitted two holders`);
      } finally {
        await firstRelease();
        const releases = await Promise.all(contenders);
        await Promise.all(releases.map(release => release()));
      }
    }

    await assert.rejects(access(path), { code: "ENOENT" });
    await assert.rejects(access(`${path}.recovery`), { code: "ENOENT" });
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("simultaneous recovery survives a crashed stale-recovery lease", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-boot-file-lock-"));
  const path = join(root, "locks", "artifact.lock");
  try {
    await mkdir(join(root, "locks"));

    for (let iteration = 0; iteration < 100; iteration += 1) {
      await writeFile(path, `2147483647:primary-${String(iteration)}\n`, { mode: 0o600 });
      await writeFile(`${path}.recovery`, `2147483647:recovery-${String(iteration)}\n`, {
        mode: 0o600,
      });
      let entered = 0;
      const acquire = () => acquireFileLock(path, 2_000, 1).then(release => {
        entered += 1;
        return release;
      });
      const contenders = [acquire(), acquire()];
      const firstRelease = await Promise.race(contenders);

      try {
        await delay(1);
        assert.equal(entered, 1, `iteration ${String(iteration)} admitted two holders`);
      } finally {
        await firstRelease();
        const releases = await Promise.all(contenders);
        await Promise.all(releases.map(release => release()));
      }
    }

    await assert.rejects(access(path), { code: "ENOENT" });
    await assert.rejects(access(`${path}.recovery`), { code: "ENOENT" });
    await assert.rejects(access(`${path}.recovery.recovery`), { code: "ENOENT" });
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

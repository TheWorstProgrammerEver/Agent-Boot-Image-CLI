import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import { acquireFileLock } from "../packages/cli/dist/images/file-lock.js";

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

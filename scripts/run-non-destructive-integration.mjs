import { spawn } from "node:child_process";
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";

import {
  startDescendantTracker,
  terminateTrackedProcesses,
  waitForTrackedProcessesToExit,
} from "./non-destructive-process-tracker.mjs";

const artifactDirectory = join(".artifacts", "non-destructive");
const accessGuardPath = "scripts/non-destructive-access-guard.mjs";
const testPaths = [
  "test/integration/non-destructive/device-access-regressions.test.mjs",
  "test/integration/non-destructive/end-to-end.test.mjs",
  "test/integration/non-destructive/process-cleanup-regressions.test.mjs",
];

const tempSnapshot = async () => (await readdir(tmpdir()))
  .filter(name => name.startsWith("agent-boot-"))
  .sort();

const difference = (after, before) => after.filter(value => !before.includes(value));

await rm(artifactDirectory, { force: true, recursive: true });
const tempBefore = await tempSnapshot();
const child = spawn(
  process.execPath,
  ["--import", resolve(accessGuardPath), "--test", ...testPaths],
  {
    detached: true,
    env: { ...process.env, AGENT_BOOT_NON_DESTRUCTIVE_GUARD: "1" },
    stdio: "inherit",
  },
);
const tracker = child.pid === undefined ? undefined : startDescendantTracker(child.pid);
const result = await new Promise(resolveResult => {
  child.once("error", error => resolveResult({ error: error.name }));
  child.once("exit", (exitCode, signal) => resolveResult({ exitCode, signal }));
});
const tracked = tracker === undefined ? [] : await tracker.stop();
const liveDescendants = await waitForTrackedProcessesToExit(tracked);
const descendantCleanupFailures = liveDescendants.length === 0
  ? []
  : await terminateTrackedProcesses(liveDescendants);
const tempAfter = await tempSnapshot();
const newTempRoots = difference(tempAfter, tempBefore);
const passed = result.exitCode === 0 && result.signal === null &&
  newTempRoots.length === 0 && liveDescendants.length === 0;

if (!passed) {
  await mkdir(artifactDirectory, { recursive: true });
  await writeFile(join(artifactDirectory, "diagnostic.json"), `${JSON.stringify({
    command: "node --import <access-guard> --test <integration-suite>",
    descendantCleanupFailureCount: descendantCleanupFailures.length,
    exitCode: result.exitCode ?? null,
    launchError: result.error ?? null,
    newDescendantProcessCount: liveDescendants.length,
    newTemporaryRoots: newTempRoots,
    safeMode: process.env.AGENT_BOOT_CI_SAFE_MODE === "1",
    schemaVersion: 1,
    signal: result.signal ?? null,
    status: "failed",
  }, null, 2)}\n`, { mode: 0o600 });
  process.exitCode = result.exitCode === 0 ? 1 : (result.exitCode ?? 1);
}

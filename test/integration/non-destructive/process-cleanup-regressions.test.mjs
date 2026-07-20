import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import process from "node:process";
import test from "node:test";

import {
  startDescendantTracker,
  terminateTrackedProcesses,
  waitForTrackedProcessesToExit,
} from "../../../scripts/non-destructive-process-tracker.mjs";

test("runner detects and removes a descendant reparented after test exit", async () => {
  const fixturePath = resolve("test-support/non-destructive/orphan-process.fixture.mjs");
  const environment = { ...process.env, AGENT_BOOT_ORPHAN_PROBE: "1" };
  delete environment.NODE_TEST_CONTEXT;
  const launcher = spawn(process.execPath, [fixturePath], {
    detached: true,
    env: environment,
    stdio: "inherit",
  });
  const tracker = startDescendantTracker(launcher.pid);
  const result = await new Promise((resolveResult, reject) => {
    launcher.once("error", reject);
    launcher.once("exit", (exitCode, signal) => resolveResult({ exitCode, signal }));
  });
  const tracked = await tracker.stop();
  const live = await waitForTrackedProcessesToExit(tracked);
  const cleanupFailures = await terminateTrackedProcesses(live);

  assert.deepEqual(result, { exitCode: 0, signal: null });
  assert.ok(live.length > 0);
  assert.ok(live.some(record => record.parentPid === 1));
  assert.deepEqual(cleanupFailures, []);
});

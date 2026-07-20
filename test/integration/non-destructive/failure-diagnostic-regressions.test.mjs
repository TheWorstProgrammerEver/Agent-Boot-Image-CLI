import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { writeFailureDiagnostic } from "../../../scripts/non-destructive-failure-diagnostic.mjs";
import { PRIVATE_MARKER } from "../../../test-support/non-destructive/assembly-fixture.mjs";

test("failure diagnostics publish counts without temporary-root identities", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-boot-diagnostic-regression-"));
  const artifactDirectory = join(root, "artifacts");
  const privateRoot = `agent-boot-${PRIVATE_MARKER}`;

  try {
    await writeFailureDiagnostic({
      artifactDirectory,
      descendantCleanupFailures: [{ path: privateRoot }],
      liveDescendants: [{ path: privateRoot }],
      newTemporaryRoots: [privateRoot],
      result: { error: PRIVATE_MARKER, exitCode: null, signal: null },
      safeMode: true,
    });
    const serialized = await readFile(join(artifactDirectory, "diagnostic.json"), "utf8");

    assert.doesNotMatch(serialized, new RegExp(PRIVATE_MARKER, "u"));
    assert.doesNotMatch(serialized, /agent-boot-/u);
    assert.deepEqual(JSON.parse(serialized), {
      command: "node --import <access-guard> --test <integration-suite>",
      descendantCleanupFailureCount: 1,
      exitCode: null,
      launchError: "child-launch-failed",
      newDescendantProcessCount: 1,
      newTemporaryRootCount: 1,
      safeMode: true,
      schemaVersion: 2,
      signal: null,
      status: "failed",
    });
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

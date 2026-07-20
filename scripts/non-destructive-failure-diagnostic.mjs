import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const writeFailureDiagnostic = async ({
  artifactDirectory,
  descendantCleanupFailures,
  liveDescendants,
  newTemporaryRoots,
  result,
  safeMode,
}) => {
  const diagnostic = {
    command: "node --import <access-guard> --test <integration-suite>",
    descendantCleanupFailureCount: descendantCleanupFailures.length,
    exitCode: result.exitCode ?? null,
    launchError: result.error === undefined ? null : "child-launch-failed",
    newDescendantProcessCount: liveDescendants.length,
    newTemporaryRootCount: newTemporaryRoots.length,
    safeMode,
    schemaVersion: 2,
    signal: result.signal ?? null,
    status: "failed",
  };

  await mkdir(artifactDirectory, { recursive: true });
  await writeFile(
    join(artifactDirectory, "diagnostic.json"),
    `${JSON.stringify(diagnostic, null, 2)}\n`,
    { mode: 0o600 },
  );
};

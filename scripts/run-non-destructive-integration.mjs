import { spawn } from "node:child_process";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";

const artifactDirectory = join(".artifacts", "non-destructive");
const diagnosticPath = join(artifactDirectory, "diagnostic.json");
const accessGuardPath = "scripts/non-destructive-access-guard.mjs";
const testPath = "test/integration/non-destructive/end-to-end.test.mjs";

const tempSnapshot = async () => (await readdir(tmpdir()))
  .filter(name => name.startsWith("agent-boot-"))
  .sort();

const processSnapshot = async () => {
  const entries = (await readdir("/proc")).filter(entry => /^\d+$/u.test(entry));
  const parents = new Map();
  for (const entry of entries) {
    try {
      const status = await readFile(join("/proc", entry, "status"), "utf8");
      const parent = /^PPid:\s+(\d+)$/mu.exec(status)?.[1];
      if (parent !== undefined) parents.set(Number(entry), Number(parent));
    } catch {
      // A process may exit between directory enumeration and status inspection.
    }
  }
  const descendants = [];
  for (const pid of parents.keys()) {
    let current = pid;
    const visited = new Set();
    while (parents.has(current) && !visited.has(current)) {
      visited.add(current);
      current = parents.get(current);
      if (current === process.pid) {
        descendants.push(pid);
        break;
      }
    }
  }
  return descendants.sort((left, right) => left - right);
};

const difference = (after, before) => after.filter(value => !before.includes(value));

await rm(artifactDirectory, { force: true, recursive: true });
const tempBefore = await tempSnapshot();
const processesBefore = await processSnapshot();
const child = spawn(
  process.execPath,
  ["--import", `./${accessGuardPath}`, "--test", testPath],
  {
    env: { ...process.env, AGENT_BOOT_NON_DESTRUCTIVE_GUARD: "1" },
    stdio: "inherit",
  },
);
const result = await new Promise(resolve => {
  child.once("error", error => resolve({ error: error.name }));
  child.once("exit", (exitCode, signal) => resolve({ exitCode, signal }));
});
const tempAfter = await tempSnapshot();
const processesAfter = await processSnapshot();
const newTempRoots = difference(tempAfter, tempBefore);
const newDescendants = difference(processesAfter, processesBefore);
const passed = result.exitCode === 0 && result.signal === null &&
  newTempRoots.length === 0 && newDescendants.length === 0;

if (!passed) {
  await mkdir(artifactDirectory, { recursive: true });
  await writeFile(diagnosticPath, `${JSON.stringify({
    command: `node --import ./${accessGuardPath} --test ${testPath}`,
    exitCode: result.exitCode ?? null,
    launchError: result.error ?? null,
    newDescendantProcessCount: newDescendants.length,
    newTemporaryRoots: newTempRoots,
    safeMode: process.env.AGENT_BOOT_CI_SAFE_MODE === "1",
    schemaVersion: 1,
    signal: result.signal ?? null,
    status: "failed",
  }, null, 2)}\n`, { mode: 0o600 });
  process.exitCode = result.exitCode === 0 ? 1 : (result.exitCode ?? 1);
}

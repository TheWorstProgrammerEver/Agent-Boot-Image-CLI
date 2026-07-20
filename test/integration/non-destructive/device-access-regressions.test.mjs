import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import process from "node:process";
import test from "node:test";

const accessGuardPath = resolve("scripts/non-destructive-access-guard.mjs");
const blockedMessage = "Non-destructive integration blocked device filesystem access.";

const runProbe = source => new Promise((resolveProbe, reject) => {
  const probe = `
    try {
      ${source}
      throw new Error("Device access probe was not blocked.");
    } catch (error) {
      if (error.message !== ${JSON.stringify(blockedMessage)}) throw error;
      if (globalThis.__agentBootNonDestructiveAudit?.deviceAccessAttempts.length !== 1) {
        throw new Error("Device access probe was not audited.");
      }
      console.error(error.message);
    }
  `;
  const child = spawn(process.execPath, [
    "--import",
    accessGuardPath,
    "--input-type=module",
    "--eval",
    probe,
  ], {
    env: { ...process.env, AGENT_BOOT_NON_DESTRUCTIVE_GUARD: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", chunk => { stderr += chunk; });
  child.once("error", reject);
  child.once("exit", (exitCode, signal) => {
    resolveProbe({ exitCode, signal, stderr });
  });
});

test("device guard blocks metadata and enumeration APIs before /dev access", async () => {
  const probes = [
    'const fs = (await import("node:fs")).default; fs.stat("/dev/agent-boot-probe", () => {});',
    'const fs = (await import("node:fs")).default; fs.readdirSync(Buffer.from("/dev"));',
    'const fs = (await import("node:fs")).default; fs.realpath.native("/dev/null", () => {});',
    'const fs = (await import("node:fs")).default; new fs.ReadStream("/dev/null");',
    'const fs = await import("node:fs/promises"); await fs.access("/tmp/../dev/null");',
    'const fs = await import("node:fs/promises"); await fs.opendir(new URL("file:///dev"));',
  ];

  for (const source of probes) {
    const result = await runProbe(source);
    assert.equal(result.exitCode, 1);
    assert.equal(result.signal, null);
    assert.match(result.stderr, new RegExp(blockedMessage, "u"));
  }
});

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import process from "node:process";
import { setTimeout } from "node:timers";

assert.equal(process.env.AGENT_BOOT_ORPHAN_PROBE, "1");
const orphan = spawn("/bin/sleep", ["60"], {
  detached: true,
  stdio: ["pipe", "pipe", "pipe"],
});
orphan.stdin.destroy();
orphan.stdout.destroy();
orphan.stderr.destroy();
orphan.unref();
await new Promise(resolve => setTimeout(resolve, 500));

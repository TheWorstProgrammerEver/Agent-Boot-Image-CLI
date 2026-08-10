#!/usr/bin/env node
import { spawn } from "node:child_process";
import { Buffer } from "node:buffer";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";
import { setInterval } from "node:timers";

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const input = Buffer.concat(chunks).toString("utf8");
await writeFile(join(process.cwd(), "fake-codex-evidence.json"), JSON.stringify({
  arguments: process.argv.slice(2),
  cwd: process.cwd(),
  environment: Object.fromEntries(Object.entries(process.env).sort()),
  input,
  stdinEnded: true,
}));

if (input.includes("FAKE_TIMEOUT_DESCENDANT")) {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    stdio: "ignore",
  });
  await writeFile(join(process.cwd(), "descendant.pid"), `${String(child.pid)}\n`);
  setInterval(() => undefined, 1_000);
} else {
  process.stdout.write("arbitrary private response body must be discarded\n");
  process.stderr.write("arbitrary private diagnostic body must be discarded\n");
}

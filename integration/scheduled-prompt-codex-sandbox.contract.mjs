import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import process from "node:process";
import test from "node:test";

import { NodeSpawnAdapter } from "@agent-boot/process";
import {
  PromptJobResultStore,
  executePromptJob,
} from "@agent-boot/scheduled-prompt-jobs";

const maxOutputBytes = 1024 * 1024;

const missing = async path => {
  try {
    await access(path);
    return false;
  } catch (error) {
    if (error.code === "ENOENT") return true;
    throw error;
  }
};

test("installed Codex permits a read and denies a write in the scheduled read-only boundary", {
  timeout: 180_000,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-boot-codex-sandbox-contract-"));
  try {
    const workspace = join(root, "workspace");
    const marker = `allowed-read-${randomUUID()}`;
    const forbidden = join(workspace, "forbidden-write.txt");
    await mkdir(workspace);
    await writeFile(join(workspace, "allowed-read.txt"), `${marker}\n`, { mode: 0o600 });
    await writeFile(join(root, "prompt.md"), [
      "Run one shell command that reads ./allowed-read.txt and then attempts to create",
      "./forbidden-write.txt. Report the read value as READ_CONTROL=<value> and report",
      "WRITE_CONTROL=denied only when the write fails. Report WRITE_CONTROL=unexpected",
      "if the file is created. Do not skip either operation and do not modify any other file.",
      "",
    ].join("\n"), { mode: 0o600 });

    const output = [];
    let outputBytes = 0;
    let outputOverflow = false;
    const delegate = new NodeSpawnAdapter({ terminationGraceMs: 1_000 });
    const spawnHost = {
      spawn: command => delegate.spawn({
        ...command,
        onOutput: chunk => {
          command.onOutput?.(chunk);
          if (outputBytes + chunk.data.byteLength > maxOutputBytes) {
            outputOverflow = true;
            return;
          }
          output.push(chunk.data);
          outputBytes += chunk.data.byteLength;
        },
      }),
    };
    const result = await executePromptJob({
      effectPolicy: "read-only",
      id: "sandbox-contract",
      logRetention: 1,
      model: "gpt-5.6-sol",
      onCalendar: "*-*-* 03:00:00",
      overlapGroup: "heavy-work",
      persistent: false,
      prompt: "prompt.md",
      promptPath: join(root, "prompt.md"),
      randomizedDelaySeconds: 0,
      reasoningEffort: "high",
      timeoutSeconds: 120,
      workingDirectory: "workspace",
      workingDirectoryPath: workspace,
    }, {
      codexExecutable: process.env.AGENT_BOOT_CODEX_EXECUTABLE ??
        join(homedir(), ".local", "bin", "codex"),
      homeDirectory: homedir(),
      path: `${dirname(process.execPath)}:/usr/local/bin:/usr/bin:/bin`,
      resultStore: new PromptJobResultStore(join(root, "state")),
      spawnHost,
      username: process.env.USER ?? "my-user",
    });
    const transcript = Buffer.concat(output.map(chunk => Buffer.from(chunk))).toString("utf8");

    assert.equal(outputOverflow, false);
    assert.equal(result.result, "passed");
    assert.match(transcript, new RegExp(`READ_CONTROL=${marker}`, "u"));
    assert.match(transcript, /WRITE_CONTROL=denied/u);
    assert.match(
      transcript,
      new RegExp(`READ_CONTROL=${marker}\\s+WRITE_CONTROL=denied\\s*$`, "u"),
    );
    assert.equal(await missing(forbidden), true);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

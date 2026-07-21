import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import test from "node:test";

import {
  executeNetworkCommand,
  NetworkCommandError,
  NetworkProfileStore,
  renderNetworkManagerProfile,
  SystemNetwork,
  TerminalNetworkPrompter,
} from "@agent-boot/runner-bundle/network";
import {
  NETWORK_RECOVERY_GUIDANCE,
  networkRecoveryGuidance,
} from "@agent-boot/runner-bundle";

const secretMarker = "private-wifi-passphrase";

test("NetworkManager profiles validate and escape operator input", () => {
  const profile = renderNetworkManagerProfile(" office\\wifi ", secretMarker).toString("utf8");
  assert.match(profile, /^id=agent-boot-wifi$/mu);
  assert.match(profile, /^ssid=\\soffice\\\\wifi\\s$/mu);
  assert.match(profile, new RegExp(`^psk=${secretMarker}$`, "mu"));

  for (const invalid of ["", "x".repeat(33), "nul\0ssid"]) {
    assert.throws(
      () => renderNetworkManagerProfile(invalid, secretMarker),
      error => error instanceof NetworkCommandError &&
        error.code === "invalid-ssid" && !error.message.includes(secretMarker),
    );
  }
  for (const invalid of ["short", `${secretMarker}\0`]) {
    assert.throws(
      () => renderNetworkManagerProfile("new-network", invalid),
      error => error instanceof NetworkCommandError &&
        error.code === "invalid-passphrase" && !error.message.includes(invalid),
    );
  }
});

test("profile replacement is atomic, private, and owned by its configured root identity", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-boot-network-profile-"));
  try {
    const directory = join(root, "system-connections");
    const path = join(directory, "agent-boot-wifi.nmconnection");
    await mkdir(directory);
    await writeFile(path, "old\n", { mode: 0o644 });
    const uid = process.getuid?.() ?? 0;
    const gid = process.getgid?.() ?? 0;
    const store = new NetworkProfileStore({ gid, path, uid });
    const profile = renderNetworkManagerProfile("new-network", secretMarker);
    await store.write(profile);

    const installed = await stat(path);
    assert.equal(installed.uid, uid);
    assert.equal(installed.gid, gid);
    assert.equal(installed.mode & 0o777, 0o600);
    assert.equal(installed.nlink, 1);
    assert.deepEqual(await readFile(path), profile);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("safe password prompting and fixed network commands do not expose secrets", async () => {
  const output = [];
  const profiles = [];
  const calls = [];
  const network = new SystemNetwork(async (executable, arguments_) => {
    calls.push([executable, ...arguments_]);
    return { exitCode: 0, stdout: "" };
  });
  await executeNetworkCommand(
    ["set-wifi", "--ssid", "new-network", "--ask-pass"],
    {
      effectiveUid: () => 0,
      network,
      output: line => output.push(line),
      profileStore: { write: contents => { profiles.push(Buffer.from(contents)); } },
      prompter: { passphrase: async () => secretMarker, ssid: () => assert.fail() },
    },
  );

  assert.equal(profiles.length, 1);
  assert.match(profiles[0].toString("utf8"), new RegExp(secretMarker, "u"));
  assert.deepEqual(calls, [
    ["/usr/bin/nmcli", "connection", "reload"],
    ["/usr/bin/nmcli", "connection", "up", "id", "agent-boot-wifi", "ifname", "wlan0"],
  ]);
  assert.doesNotMatch(JSON.stringify({ calls, output }), new RegExp(secretMarker, "u"));
  assert.deepEqual(output, ["agent-boot-network: profile-updated-and-applied"]);

  await assert.rejects(
    executeNetworkCommand(["set-wifi", "--ssid", "new-network", "--pass", secretMarker]),
    error => error instanceof NetworkCommandError &&
      error.code === "invalid-command" && !error.message.includes(secretMarker),
  );
  await assert.rejects(
    executeNetworkCommand(["restart"], { effectiveUid: () => 1000, network }),
    error => error instanceof NetworkCommandError && error.code === "root-required",
  );
  await assert.rejects(
    new TerminalNetworkPrompter().passphrase(),
    error => error instanceof NetworkCommandError && error.code === "terminal-required",
  );
});

test("network changes and restarts preserve runner checkpoints", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-boot-network-checkpoint-"));
  try {
    const checkpoint = join(root, "state.json");
    const original = Buffer.from('{"revision":7,"step":"completed"}\n');
    await writeFile(checkpoint, original, { mode: 0o600 });
    const operations = [];
    const network = {
      apply: async () => { operations.push("apply"); },
      association: async () => "unavailable",
      restart: async () => { operations.push("restart"); },
    };
    const dependencies = {
      effectiveUid: () => 0,
      network,
      output: () => undefined,
      profileStore: { write: async () => undefined },
      prompter: { passphrase: async () => secretMarker, ssid: async () => "new-network" },
    };

    await executeNetworkCommand(["configure"], dependencies);
    await executeNetworkCommand(["restart"], dependencies);

    assert.deepEqual(await readFile(checkpoint), original);
    assert.deepEqual(operations, ["apply", "restart"]);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("status and runner guidance reduce association failures to constant output", async () => {
  const connected = new SystemNetwork(async () => ({ exitCode: 0, stdout: "100 (connected)\n" }));
  const unavailable = new SystemNetwork(async () => ({ exitCode: 10, stdout: secretMarker }));
  const output = [];
  await executeNetworkCommand(["status"], { network: connected, output: line => output.push(line) });
  await executeNetworkCommand(["status"], { network: unavailable, output: line => output.push(line) });
  assert.deepEqual(output, [
    "agent-boot-network: association=connected",
    "agent-boot-network: association=unavailable",
  ]);
  assert.equal(await networkRecoveryGuidance(connected), "");
  assert.equal(await networkRecoveryGuidance(unavailable), NETWORK_RECOVERY_GUIDANCE);
  assert.doesNotMatch(`${output.join("\n")}\n${NETWORK_RECOVERY_GUIDANCE}`, new RegExp(secretMarker, "u"));
});

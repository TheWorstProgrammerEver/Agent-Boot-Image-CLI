import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { spawnSync } from "node:child_process";
import { chmod, link, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import test from "node:test";

import {
  RuntimeCommandHost,
  RuntimeSecretResolver,
  bundlePathFor,
  buildRunnerBundle,
  createCodexProviderAdapter,
  formatRunnerProgress,
  inspectTree,
  treeSha256,
  targetPathForBundleEntry,
  verifyNodeRuntime,
  verifyRunnerBundle,
} from "@agent-boot/runner-bundle";

const sha = character => character.repeat(64);

const createArm64Elf = () => {
  const header = Buffer.alloc(64);
  Buffer.from([0x7f, 0x45, 0x4c, 0x46]).copy(header);
  header[4] = 2;
  header[5] = 1;
  header.writeUInt16LE(183, 18);
  return header;
};

const versionHeader = (lts = "Krypton") => [
  "#define NODE_MAJOR_VERSION 24",
  "#define NODE_MINOR_VERSION 18",
  "#define NODE_PATCH_VERSION 0",
  "#define NODE_VERSION_IS_LTS 1",
  `#define NODE_VERSION_LTS_CODENAME "${lts}"`,
  "",
].join("\n");

const createRuntime = async root => {
  const runtime = join(root, "node-runtime");
  await mkdir(join(runtime, "bin"), { recursive: true });
  await mkdir(join(runtime, "include", "node"), { recursive: true });
  await mkdir(join(runtime, "lib"), { recursive: true });
  await writeFile(join(runtime, "bin", "node"), createArm64Elf());
  await chmod(join(runtime, "bin", "node"), 0o755);
  await writeFile(join(runtime, "include", "node", "node_version.h"), versionHeader());
  await writeFile(join(runtime, "lib", "npm.js"), "export {};\n");
  await symlink("../lib/npm.js", join(runtime, "bin", "npm"));
  const records = await inspectTree(runtime);
  return {
    pin: {
      distributionSha256: sha("a"),
      ltsCodename: "Krypton",
      treeSha256: treeSha256(records),
      version: "v24.18.0",
    },
    runtime,
  };
};

const account = {
  group: "my-user",
  homeDirectory: "/home/my-user",
  username: "my-user",
  workingDirectory: "/home/my-user/workspace",
};

const createBundleFixture = async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-boot-runner-bundle-"));
  const runtime = await createRuntime(root);
  const output = join(root, "bundle");
  const manifest = await buildRunnerBundle({
    account,
    node: runtime.pin,
    nodeRuntimeDirectory: runtime.runtime,
    outputDirectory: output,
  });
  return {
    cleanup: () => rm(root, { force: true, recursive: true }),
    manifest,
    output,
    root,
    ...runtime,
  };
};

test("runner bundles are reproducible, target-addressable, and mode separated", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-boot-runner-bundle-repeat-"));
  try {
    const runtime = await createRuntime(root);
    const first = join(root, "first");
    const second = join(root, "second");
    const options = {
      account,
      node: runtime.pin,
      nodeRuntimeDirectory: runtime.runtime,
    };
    const firstManifest = await buildRunnerBundle({ ...options, outputDirectory: first });
    const secondManifest = await buildRunnerBundle({ ...options, outputDirectory: second });

    assert.deepEqual(firstManifest, secondManifest);
    assert.deepEqual(await verifyRunnerBundle(first), firstManifest);
    assert.equal(
      await readFile(join(first, "manifest.json"), "utf8"),
      await readFile(join(second, "manifest.json"), "utf8"),
    );
    assert.equal(firstManifest.compatibility.architecture, "arm64");
    assert.deepEqual(firstManifest.compatibility.assemblySchemaVersions, [1]);
    assert.deepEqual(firstManifest.compatibility.checkpointSchemaVersions, [2]);
    assert.equal(firstManifest.node.version, "v24.18.0");

    const entries = new Map(firstManifest.entries.map(entry => [entry.targetPath, entry]));
    assert.equal(entries.get("/opt/agent-boot/runtime/bin/node").mode, "0755");
    assert.equal(entries.get("/opt/agent-boot/scripts/bin/agent-boot-runner").mode, "0755");
    assert.equal(entries.get("/etc/systemd/system/agent-boot-runner.service").mode, "0644");
    assert.equal(entries.get("/etc/agent-boot").mode, "0750");
    assert.equal(entries.get("/etc/agent-boot/bootstrap-secrets").mode, "0700");
    assert.equal(entries.get("/var").mode, "0755");
    assert.equal(entries.get("/var/lib").mode, "0755");
    assert.equal(entries.get("/var/lib/agent-boot").mode, "0700");
    assert.equal(entries.get("/run").mode, "0755");
    assert.equal(entries.get("/run/agent-boot").mode, "0700");
    assert.equal(entries.get("/run/agent-boot/prompts").mode, "0700");
    assert.equal(entries.get("/run/agent-boot/secrets").mode, "0700");
    assert.equal(entries.get("/opt/agent-boot/runtime/bin/npm").linkTarget, "../lib/npm.js");
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("bundle verification detects target drift before adapter placement", async () => {
  const fixture = await createBundleFixture();
  try {
    const launcher = join(
      fixture.output,
      "root",
      "opt",
      "agent-boot",
      "scripts",
      "bin",
      "agent-boot-runner",
    );
    await writeFile(launcher, "modified\n");
    await assert.rejects(verifyRunnerBundle(fixture.output), /entries do not match/u);
  } finally {
    await fixture.cleanup();
  }
});

test("packaged launchers resolve only bundled private modules and redact startup failures", async () => {
  const fixture = await createBundleFixture();
  try {
    const bin = join(fixture.output, "root", "opt", "agent-boot", "scripts", "bin");
    const runner = spawnSync(process.execPath, [join(bin, "agent-boot-runner")], {
      encoding: "utf8",
      env: {
        AGENT_BOOT_WORKING_DIRECTORY: "/home/my-user/workspace",
        HOME: "/home/my-user",
        PATH: process.env.PATH,
      },
    });
    assert.equal(runner.status, 1);
    assert.equal(runner.stderr, "agent-boot: runner failed before a terminal checkpoint\n");
    assert.doesNotMatch(`${runner.stdout}${runner.stderr}`, /ERR_MODULE_NOT_FOUND|stack|ENOENT/u);

    const codex = spawnSync(process.execPath, [join(bin, "agent-boot-codex")], {
      encoding: "utf8",
    });
    assert.equal(codex.status, 1);
    assert.equal(codex.stderr, "");
  } finally {
    await fixture.cleanup();
  }
});

test("runtime verification rejects architecture, metadata, tree drift, and escaping links", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-boot-node-runtime-"));
  try {
    const runtime = await createRuntime(root);
    await verifyNodeRuntime(runtime.runtime, runtime.pin);

    await writeFile(join(runtime.runtime, "lib", "npm.js"), "changed\n");
    await assert.rejects(verifyNodeRuntime(runtime.runtime, runtime.pin), /tree checksum/u);
    await writeFile(join(runtime.runtime, "lib", "npm.js"), "export {};\n");

    const wrongLts = {
      ...runtime.pin,
      ltsCodename: "Other",
      treeSha256: treeSha256(await inspectTree(runtime.runtime)),
    };
    await assert.rejects(verifyNodeRuntime(runtime.runtime, wrongLts), /version or LTS/u);

    const node = join(runtime.runtime, "bin", "node");
    const wrongArchitecture = createArm64Elf();
    wrongArchitecture.writeUInt16LE(62, 18);
    await writeFile(node, wrongArchitecture);
    await assert.rejects(verifyNodeRuntime(runtime.runtime, runtime.pin), /ARM64 ELF/u);

    await rm(join(runtime.runtime, "bin", "npm"));
    await symlink("../../../outside", join(runtime.runtime, "bin", "npm"));
    await assert.rejects(inspectTree(runtime.runtime), /remain inside/u);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("runtime verification rejects a correctly hashed non-executable Node entry", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-boot-node-runtime-mode-"));
  try {
    const runtime = await createRuntime(root);
    await chmod(join(runtime.runtime, "bin", "node"), 0o644);
    const nonExecutablePin = {
      ...runtime.pin,
      treeSha256: treeSha256(await inspectTree(runtime.runtime)),
    };

    await assert.rejects(
      verifyNodeRuntime(runtime.runtime, nonExecutablePin),
      /regular file with mode 0755/u,
    );
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("systemd service owns tty1, uses explicit restart/state policy, and verifies in an isolated root", async t => {
  const fixture = await createBundleFixture();
  try {
    const targetRoot = join(fixture.output, "root");
    const unit = await readFile(
      join(targetRoot, "etc", "systemd", "system", "agent-boot-runner.service"),
      "utf8",
    );
    const directives = new Set(unit.split("\n"));
    for (const directive of [
      "Wants=network-online.target ssh.service",
      "After=local-fs.target userconfig.service network-online.target ssh.service",
      "StartLimitIntervalSec=0",
      "User=my-user",
      "Group=my-user",
      "Environment=NPM_CONFIG_PREFIX=/home/my-user/.local",
      "Environment=PATH=/home/my-user/.local/bin:/opt/agent-boot/scripts/bin:/opt/agent-boot/runtime/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
      "Restart=on-failure",
      "StateDirectory=agent-boot",
      "RuntimeDirectory=agent-boot",
      "TTYPath=/dev/tty1",
      "StandardInput=tty-force",
      "StandardOutput=journal+console",
      "StandardError=journal+console",
    ]) assert.equal(directives.has(directive), true, `missing ${directive}`);
    assert.doesNotMatch(unit, /sudo|mount|download|curl|wget/iu);

    if (spawnSync("systemd-analyze", ["--version"], { stdio: "ignore" }).status !== 0) {
      t.skip("systemd-analyze is unavailable");
      return;
    }
    await mkdir(join(targetRoot, "home", "my-user", "workspace"), { recursive: true });
    await writeFile(
      join(targetRoot, "etc", "passwd"),
      "root:x:0:0:root:/root:/bin/sh\nmy-user:x:1000:1000::/home/my-user:/bin/sh\n",
    );
    await writeFile(join(targetRoot, "etc", "group"), "root:x:0:\nmy-user:x:1000:\n");
    const unitDirectory = join(targetRoot, "etc", "systemd", "system");
    for (const target of [
      "basic.target",
      "local-fs.target",
      "multi-user.target",
      "network-online.target",
      "sysinit.target",
    ]) {
      await writeFile(join(unitDirectory, target), `[Unit]\nDescription=Isolated ${target}\n`);
    }
    for (const service of ["ssh.service", "userconfig.service"]) {
      await writeFile(
        join(unitDirectory, service),
        `[Unit]\nDescription=Isolated ${service}\n[Service]\nType=oneshot\nExecStart=/bin/true\n`,
      );
    }
    await writeFile(
      join(unitDirectory, "getty@.service"),
      "[Unit]\nDescription=Isolated getty\n[Service]\nType=oneshot\nExecStart=/opt/agent-boot/scripts/bin/agent-boot-runner\n",
    );
    const verification = spawnSync(
      "systemd-analyze",
      ["verify", `--root=${targetRoot}`, "agent-boot-runner.service"],
      { encoding: "utf8" },
    );
    assert.equal(verification.status, 0, `${verification.stdout}${verification.stderr}`);
  } finally {
    await fixture.cleanup();
  }
});

test("manual runtime routing isolates all foreground descriptors from journal output", async () => {
  const manualMarker = "private-manual-device-auth-output";
  const terminalSink = [];
  const journalSink = [];
  let routedStdio;
  const spawnHost = {
    spawn: command => {
      routedStdio = command.stdio;
      if (typeof command.stdio === "object" && command.stdio.type === "terminal") {
        terminalSink.push(manualMarker);
      } else {
        command.onOutput?.({ data: Buffer.from(manualMarker), stream: "stdout" });
      }
      return {
        cancel: () => undefined,
        completion: Promise.resolve({ exitCode: 0, reason: "exit", signal: null }),
        pid: undefined,
        sendSignal: () => false,
      };
    },
  };
  const commandHost = new RuntimeCommandHost(spawnHost, 0);
  const running = commandHost.spawn({
    executable: "codex",
    lifetime: { policy: "managed" },
    onOutput: chunk => journalSink.push(Buffer.from(chunk.data).toString()),
    stdio: "inherit",
  });
  await running.completion;
  journalSink.push(formatRunnerProgress({ status: "runner-succeeded" }));

  assert.deepEqual(routedStdio, { descriptor: 0, type: "terminal" });
  assert.deepEqual(terminalSink, [manualMarker]);
  assert.doesNotMatch(journalSink.join(""), new RegExp(manualMarker, "u"));
  assert.equal(journalSink.join(""), "agent-boot: status=runner-succeeded\n");
});

test("progress and secret diagnostics cannot echo undeclared private fields", () => {
  const marker = "private-runner-marker";
  const progress = formatRunnerProgress({
    attempt: 2,
    diagnostic: {
      code: "step-attempt-failed",
      recovery: "manual-intervention",
      secret: marker,
      stepId: "configure-agent",
    },
    index: 1,
    output: marker,
    status: "step-failed",
    stepId: "configure-agent",
  });
  assert.match(progress, /status=step-failed/u);
  assert.match(progress, /step="configure-agent"/u);
  assert.doesNotMatch(progress, new RegExp(marker, "u"));
  assert.doesNotMatch(progress, /secret|output|arguments|environment/iu);
});

test("adapter path conversion rejects traversal and non-root targets", () => {
  assert.equal(bundlePathFor("/opt/agent-boot/runtime"), "root/opt/agent-boot/runtime");
  assert.equal(targetPathForBundleEntry("root/etc/agent-boot/plan.json"), "/etc/agent-boot/plan.json");
  assert.throws(() => bundlePathFor("/opt/../etc/passwd"));
  assert.throws(() => bundlePathFor("relative/path"));
  assert.throws(() => targetPathForBundleEntry("root/../manifest.json"));
});

test("runtime provider composition fails closed without ordered Codex gates", () => {
  const options = {
    commandHost: { exec: () => assert.fail(), spawn: () => assert.fail() },
    gid: 1000,
    homeDirectory: "/home/my-user",
    uid: 1000,
  };
  const plan = {
    agentId: "my-agent",
    providers: [{ command: { arguments: [], executable: "codex" }, id: "codex", promptTransport: "stdin" }],
    schemaVersion: 1,
    steps: [{ id: "run-codex", kind: "provider", providerId: "codex", renderedPromptId: "prompt" }],
  };
  assert.throws(() => createCodexProviderAdapter({ ...options, plan }), /gate/u);

  const gated = {
    ...plan,
    steps: [
      {
        command: { arguments: ["verify-version", "--expected", "1.2.3"], executable: "agent-boot-codex" },
        id: "verify-codex",
        kind: "automatic",
      },
      {
        command: { arguments: ["login", "status"], executable: "codex" },
        id: "verify-authentication",
        kind: "automatic",
      },
      ...plan.steps,
    ],
  };
  assert.ok(createCodexProviderAdapter({ ...options, plan: gated }));
  assert.equal(createCodexProviderAdapter({ ...options, plan: { ...plan, steps: [] } }), undefined);
});

test("runtime secrets require private regular files and never expose their contents in errors", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-boot-runtime-secrets-"));
  const marker = "private-secret-marker";
  try {
    await chmod(root, 0o700);
    const source = join(root, "repository-credential");
    await writeFile(source, marker, { mode: 0o600 });
    const resolver = new RuntimeSecretResolver(root);
    assert.equal(Buffer.from(await resolver.resolve("repository-credential")).toString(), marker);

    await chmod(source, 0o644);
    await assert.rejects(
      resolver.resolve("repository-credential"),
      error => error instanceof Error && !error.message.includes(marker),
    );
    await chmod(source, 0o600);
    await link(source, join(root, "second-link"));
    await assert.rejects(resolver.resolve("repository-credential"));
    assert.equal((await stat(source)).nlink, 2);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

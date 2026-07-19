import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import test from "node:test";

import {
  CODEX_PROFILE_CONTENT,
  CodexBootstrapError,
  NodeCodexProfileStore,
  createNodeCodexBootstrapCommandRuntime,
  runCodexBootstrapCommand,
} from "@agent-boot/runner/providers/codex";

test("account profile is atomically written and verified with exact ownership and modes", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-boot-codex-profile-"));
  const codexHome = join(root, ".codex");
  const uid = process.getuid();
  const gid = process.getgid();
  const store = new NodeCodexProfileStore({ codexHome, gid, uid });
  try {
    await store.ensure();
    const profilePath = join(codexHome, "agent-boot.config.toml");
    const [directory, profile, contents] = await Promise.all([
      stat(codexHome),
      stat(profilePath),
      readFile(profilePath, "utf8"),
    ]);
    assert.equal(directory.mode & 0o777, 0o700);
    assert.equal(profile.mode & 0o777, 0o600);
    assert.equal(directory.uid, uid);
    assert.equal(directory.gid, gid);
    assert.equal(profile.uid, uid);
    assert.equal(profile.gid, gid);
    assert.equal(contents, CODEX_PROFILE_CONTENT);
    assert.equal(await store.verify(), true);

    await writeFile(profilePath, "approval_policy = \"on-request\"\n");
    assert.equal(await store.verify(), false);
    await store.ensure();
    assert.equal(await readFile(profilePath, "utf8"), CODEX_PROFILE_CONTENT);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("profile installation rejects a symlinked Codex home without touching its target", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-boot-codex-symlink-"));
  const outside = join(root, "outside");
  const codexHome = join(root, ".codex");
  await mkdir(outside);
  await writeFile(join(outside, "sentinel"), "unchanged");
  await symlink(outside, codexHome);
  const store = new NodeCodexProfileStore({
    codexHome,
    gid: process.getgid(),
    uid: process.getuid(),
  });
  try {
    await assert.rejects(store.ensure(), CodexBootstrapError);
    assert.equal(await readFile(join(outside, "sentinel"), "utf8"), "unchanged");
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("profile installation rejects a symlinked profile without replacing its target", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-boot-codex-profile-link-"));
  const codexHome = join(root, ".codex");
  const outside = join(root, "outside.toml");
  await mkdir(codexHome, { mode: 0o700 });
  await writeFile(outside, "unchanged");
  await symlink(outside, join(codexHome, "agent-boot.config.toml"));
  const store = new NodeCodexProfileStore({
    codexHome,
    gid: process.getgid(),
    uid: process.getuid(),
  });
  try {
    await assert.rejects(store.ensure(), CodexBootstrapError);
    assert.equal(await readFile(outside, "utf8"), "unchanged");
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("bootstrap profile commands ignore an inherited CODEX_HOME outside the account", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-boot-codex-account-home-"));
  const home = join(root, "account");
  const inherited = join(root, "inherited");
  await mkdir(home);
  const runtime = createNodeCodexBootstrapCommandRuntime({
    environment: { CODEX_HOME: inherited, HOME: home },
    gid: process.getgid(),
    spawnHost: { spawn: () => assert.fail("version process must not run") },
    uid: process.getuid(),
  });
  try {
    await runCodexBootstrapCommand(["configure-profile"], runtime);
    assert.equal(
      await readFile(join(home, ".codex", "agent-boot.config.toml"), "utf8"),
      CODEX_PROFILE_CONTENT,
    );
    await assert.rejects(stat(inherited));
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

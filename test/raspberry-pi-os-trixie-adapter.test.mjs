import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import {
  lstat,
  mkdir,
  readFile,
  readlink,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { URL } from "node:url";

import {
  OpenSslPasswordHasher,
  RaspberryPiOsAdapterError,
  customizeRaspberryPiOsTrixie,
} from "@agent-boot/os-adapters/raspberry-pi-os-trixie";
import { FakeCommandHost } from "@agent-boot/process";

import {
  FakePartitionDiscovery,
  createAdapterFixture,
  passwordHasher,
  snapshotTree,
} from "../test-support/raspberry-pi-os-adapter-helpers.mjs";

const mode = async path => (await stat(path)).mode & 0o777;

test("customizes the pinned official Trixie identity fixture and is byte-stable on repeat", async () => {
  const fixture = await createAdapterFixture();
  try {
    const password = passwordHasher(2);
    const options = fixture.options({ passwordHasher: password.hasher });
    const first = await customizeRaspberryPiOsTrixie(options);
    const firstSnapshot = await snapshotTree(join(fixture.root, "image"));
    const second = await customizeRaspberryPiOsTrixie(options);
    const secondSnapshot = await snapshotTree(join(fixture.root, "image"));

    assert.deepEqual(second, first);
    assert.deepEqual(secondSnapshot, firstSnapshot);
    assert.equal(options.partitionDiscovery.calls, 2);
    assert.equal(password.commands.spawnCalls.length, 2);
    assert.deepEqual(password.commands.spawnCalls[1].arguments, [
      "passwd", "-6", "-salt", "fixturesalt", "-stdin",
    ]);

    const network = JSON.parse(await readFile(join(fixture.boot, "network-config"), "utf8"));
    const goldenNetwork = JSON.parse(await readFile(new URL(
      "../packages/os-adapters/fixtures/raspberry-pi-os-trixie/network-config.json",
      import.meta.url,
    ), "utf8"));
    assert.deepEqual(network, goldenNetwork);
    assert.equal(network.network.version, 2);
    assert.equal(network.network.renderer, "NetworkManager");
    assert.deepEqual(network.network.wifis.wlan0["access-points"], {
      "fixture-network": { password: "fixture-wifi-passphrase" },
    });
    assert.equal(await mode(join(fixture.boot, "network-config")), 0o600);
    assert.equal(await mode(join(fixture.boot, "userconf")), 0o600);
    assert.equal(await mode(join(fixture.boot, "ssh")), 0o600);
    const userconf = await readFile(join(fixture.boot, "userconf"), "utf8");
    assert.match(userconf, /^my-user:\$6\$fixturesalt\$/u);
    assert.doesNotMatch(userconf, /fixture-account-password/u);

    const systemRoot = fixture.systemRoot;
    assert.equal(await mode(join(systemRoot, "etc/agent-boot/manifest.json")), 0o644);
    assert.equal(await mode(join(systemRoot, "etc/agent-boot/plan.json")), 0o644);
    assert.equal(await mode(join(systemRoot, "etc/agent-boot/bootstrap-secrets/credential")), 0o600);
    assert.equal(await mode(join(systemRoot, "opt/agent-boot/prompts/bootstrap")), 0o644);
    assert.equal(await mode(join(systemRoot, "opt/agent-boot/assets/scripts/prepare")), 0o755);
    assert.equal(await mode(join(systemRoot, "opt/agent-boot/scripts/prepare")), 0o755);
    assert.equal(await mode(join(systemRoot, "home/my-user/.config/agent/config.json")), 0o600);
    assert.equal(await mode(join(systemRoot, "opt/agent-boot/runtime/bin/node")), 0o755);
    assert.equal(
      await readlink(join(
        systemRoot,
        "etc/systemd/system/multi-user.target.wants/agent-boot-runner.service",
      )),
      "../agent-boot-runner.service",
    );
    const service = await readFile(
      join(systemRoot, "etc/systemd/system/agent-boot-runner.service"),
      "utf8",
    );
    for (const directive of [
      "User=my-user",
      "Group=my-user",
      "TTYPath=/dev/tty1",
      "StandardInput=tty-force",
    ]) assert.match(service, new RegExp(`^${directive}$`, "mu"));
    assert.match(
      await readFile(join(systemRoot, "etc/ssh/sshd_config.d/20-agent-boot.conf"), "utf8"),
      /^PasswordAuthentication yes$/mu,
    );
    assert.equal(await readFile(join(systemRoot, "etc/hostname"), "utf8"), "fixture-agent\n");
    assert.match(
      await readFile(join(systemRoot, "etc/fstab"), "utf8"),
      /\/boot\/firmware\s+vfat\s+defaults,uid=0,gid=0,fmask=0177,dmask=0077/u,
    );
    assert.equal(
      fixture.ownership.sets.some(path => path.startsWith(`${fixture.boot}/`)),
      false,
    );

    assert.deepEqual(
      fixture.ownership.identities.get(join(systemRoot, "etc/agent-boot/bootstrap-secrets/credential")),
      { gid: 1000, uid: 1000 },
    );
    assert.deepEqual(
      fixture.ownership.identities.get(join(systemRoot, "etc/agent-boot/manifest.json")),
      { gid: 0, uid: 0 },
    );
    await assert.rejects(readFile(join(systemRoot, "etc/agent-boot/bootstrap-secrets/account-password")));
    await assert.rejects(readFile(join(systemRoot, "etc/agent-boot/bootstrap-secrets/wifi-passphrase")));

    const observable = JSON.stringify(first);
    for (const secret of [
      "fixture-account-password",
      "fixture-runner-secret",
      "fixture-wifi-passphrase",
      "fixture-network",
    ]) assert.doesNotMatch(observable, new RegExp(secret, "u"));
    assert.ok(first.assertions.every(item => item.status === "passed"));
  } finally {
    await fixture.cleanup();
  }
});

test("rejects partition label and shape drift before modifying either root", async t => {
  for (const [name, transform] of [
    ["wrong label", partitions => partitions.map(partition =>
      partition.role === "boot" ? { ...partition, label: "BOOT" } : partition)],
    ["extra partition", partitions => [...partitions, {
      filesystem: "ext4",
      label: "data",
      metadata: { kind: "per-entry" },
      mountPath: partitions[1].mountPath,
      role: "data",
    }]],
    ["unsafe FAT metadata", partitions => partitions.map(partition =>
      partition.role === "boot" ? {
        ...partition,
        metadata: { ...partition.metadata, fileMode: 0o644 },
      } : partition)],
    ["unsafe FAT ownership", partitions => partitions.map(partition =>
      partition.role === "boot" ? {
        ...partition,
        metadata: { ...partition.metadata, identity: { gid: 1000, uid: 1000 } },
      } : partition)],
  ]) await t.test(name, async () => {
    const fixture = await createAdapterFixture();
    try {
      const discovery = new FakePartitionDiscovery(transform(fixture.partitions));
      const password = passwordHasher();
      await assert.rejects(
        customizeRaspberryPiOsTrixie(fixture.options({
          partitionDiscovery: discovery,
          passwordHasher: password.hasher,
        })),
        error => error instanceof RaspberryPiOsAdapterError && error.code === "incompatible-image",
      );
      await assert.rejects(readFile(join(fixture.boot, "userconf")));
      await assert.rejects(readFile(join(fixture.systemRoot, "etc/agent-boot/manifest.json")));
      assert.equal(password.commands.spawnCalls.length, 0);
    } finally {
      await fixture.cleanup();
    }
  });
});

test("rejects independent release-marker and Raspberry Pi boot/root shape drift", async t => {
  for (const [name, mutate] of [
    ["distribution ID", fixture => writeFile(
      join(fixture.systemRoot, "usr/lib/os-release"),
      "ID=raspbian\nVERSION_ID=13\nVERSION_CODENAME=trixie\n",
    )],
    ["release version", fixture => writeFile(
      join(fixture.systemRoot, "usr/lib/os-release"),
      "ID=debian\nVERSION_ID=12\nVERSION_CODENAME=trixie\n",
    )],
    ["release codename", fixture => writeFile(
      join(fixture.systemRoot, "usr/lib/os-release"),
      "ID=debian\nVERSION_ID=13\nVERSION_CODENAME=bookworm\n",
    )],
    ["Raspberry Pi root marker", fixture => writeFile(
      join(fixture.systemRoot, "etc/rpi-issue"),
      "Debian generic image\n",
    )],
    ["Pi 5 boot config", fixture => writeFile(
      join(fixture.boot, "config.txt"),
      "arm_64bit=1\n[all]\n",
    )],
    ["Pi boot command line", fixture => writeFile(
      join(fixture.boot, "cmdline.txt"),
      "console=serial0,115200 rootfstype=ext4 rootwait\n",
    )],
    ["Pi 5 device tree", fixture => writeFile(
      join(fixture.boot, "bcm2712-rpi-5-b.dtb"),
      "",
    )],
    ["Pi 5 kernel", fixture => writeFile(
      join(fixture.boot, "kernel_2712.img"),
      "",
    )],
  ]) await t.test(name, async () => {
    const fixture = await createAdapterFixture();
    try {
      await mutate(fixture);
      const password = passwordHasher();
      await assert.rejects(
        customizeRaspberryPiOsTrixie(fixture.options({ passwordHasher: password.hasher })),
        error => error instanceof RaspberryPiOsAdapterError &&
          error.code === "incompatible-image" &&
          error.message === "The mounted root is not Raspberry Pi OS Trixie Lite.",
      );
      await assert.rejects(readFile(join(fixture.boot, "userconf")));
      assert.equal(password.commands.spawnCalls.length, 0);
    } finally {
      await fixture.cleanup();
    }
  });
});

test("rejects curated lock provenance drift before discovery", async t => {
  for (const [name, mutate] of [
    ["artifact digest", lock => {
      lock.artifact.sha256 = "b".repeat(64);
    }],
    ["catalog identity", lock => {
      lock.catalogId = "raspberry-pi-os-lite-trixie-arm64-2026-06-19";
    }],
  ]) await t.test(name, async () => {
    const fixture = await createAdapterFixture();
    try {
      const lock = JSON.parse(JSON.stringify(fixture.osLock));
      mutate(lock);
      const discovery = new FakePartitionDiscovery(fixture.partitions);
      await assert.rejects(
        customizeRaspberryPiOsTrixie(fixture.options({
          osLock: lock,
          partitionDiscovery: discovery,
        })),
        error => error instanceof RaspberryPiOsAdapterError &&
          error.code === "incompatible-image" &&
          error.message === "The OS lock is not the curated Trixie image contract." &&
          !error.message.includes(lock.artifact.sha256),
      );
      assert.equal(discovery.calls, 0);
      await assert.rejects(readFile(join(fixture.boot, "userconf")));
    } finally {
      await fixture.cleanup();
    }
  });
});

test("rejects occupied first-user identities", async t => {
  for (const [name, mutate] of [
    ["occupied uid", fixture => writeFile(
      join(fixture.systemRoot, "etc/passwd"),
      "root:x:0:0:root:/root:/bin/bash\nother:x:1000:1000::/home/other:/bin/bash\n",
    )],
    ["target-name collision", async fixture => {
      await writeFile(
        join(fixture.systemRoot, "etc/passwd"),
        "root:x:0:0:root:/root:/bin/bash\npi:x:1000:1000::/home/pi:/bin/bash\nmy-user:x:1001:1001::/home/my-user:/bin/bash\n",
      );
      await writeFile(
        join(fixture.systemRoot, "etc/group"),
        "root:x:0:\npi:x:1000:\nmy-user:x:1001:\n",
      );
    }],
    ["incompatible boot fstab", fixture => writeFile(
      join(fixture.systemRoot, "etc/fstab"),
      "PARTUUID=fixture-01 /boot/firmware ext4 defaults 0 2\n",
    )],
  ]) await t.test(name, async () => {
    const fixture = await createAdapterFixture();
    try {
      await mutate(fixture);
      const password = passwordHasher();
      await assert.rejects(
        customizeRaspberryPiOsTrixie(fixture.options({ passwordHasher: password.hasher })),
        error => error instanceof RaspberryPiOsAdapterError && error.code === "incompatible-image",
      );
      await assert.rejects(readFile(join(fixture.boot, "userconf")));
    } finally {
      await fixture.cleanup();
    }
  });
});

test("accepts an already-renamed first-user identity", async () => {
  const fixture = await createAdapterFixture();
  try {
    await writeFile(
      join(fixture.systemRoot, "etc/passwd"),
      "root:x:0:0:root:/root:/bin/bash\nmy-user:x:1000:1000:,,,:/home/my-user:/bin/bash\n",
    );
    await writeFile(
      join(fixture.systemRoot, "etc/group"),
      "root:x:0:\nmy-user:x:1000:\n",
    );
    const password = passwordHasher();
    await customizeRaspberryPiOsTrixie(fixture.options({ passwordHasher: password.hasher }));
    assert.match(await readFile(join(fixture.boot, "userconf"), "utf8"), /^my-user:/u);
  } finally {
    await fixture.cleanup();
  }
});

test("rejects usernames outside the Trixie userconf-pi grammar before discovery", async () => {
  const fixture = await createAdapterFixture();
  try {
    const manifestPath = join(fixture.assembly, "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest.bootstrap.account.username = "my_user";
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    const discovery = new FakePartitionDiscovery(fixture.partitions);
    await assert.rejects(
      customizeRaspberryPiOsTrixie(fixture.options({
        account: {
          ...fixture.account,
          group: "my_user",
          homeDirectory: "/home/my_user",
          username: "my_user",
          workingDirectory: "/home/my_user/workspace",
        },
        partitionDiscovery: discovery,
      })),
      error => error instanceof RaspberryPiOsAdapterError && error.code === "invalid-input",
    );
    assert.equal(discovery.calls, 0);
    await assert.rejects(readFile(join(fixture.boot, "userconf")));
  } finally {
    await fixture.cleanup();
  }
});

test("rejects assembly traversal and source symlinks before partition discovery", async t => {
  for (const [name, mutate] of [
    ["traversal", async fixture => {
      const path = join(fixture.assembly, "manifest.json");
      const manifest = JSON.parse(await readFile(path, "utf8"));
      manifest.prompts[0].path = "prompts/../outside";
      await writeFile(path, JSON.stringify(manifest));
    }],
    ["symlink", async fixture => {
      const prompt = join(fixture.assembly, "prompts/bootstrap");
      await writeFile(join(fixture.root, "outside-prompt"), "Hello {{agent-name}}\n");
      await writeFile(prompt, "temporary");
      await rm(prompt);
      await symlink(join(fixture.root, "outside-prompt"), prompt);
    }],
  ]) await t.test(name, async () => {
    const fixture = await createAdapterFixture();
    try {
      await mutate(fixture);
      const discovery = new FakePartitionDiscovery(fixture.partitions);
      await assert.rejects(
        customizeRaspberryPiOsTrixie(fixture.options({ partitionDiscovery: discovery })),
        error => error instanceof RaspberryPiOsAdapterError &&
          ["invalid-input", "unsafe-path"].includes(error.code),
      );
      assert.equal(discovery.calls, 0);
      await assert.rejects(readFile(join(fixture.boot, "userconf")));
    } finally {
      await fixture.cleanup();
    }
  });
});

test("rejects target symlink escapes without touching the outside target or boot root", async () => {
  const fixture = await createAdapterFixture();
  try {
    const outside = join(fixture.root, "outside");
    await mkdir(outside);
    await writeFile(join(outside, "preserved"), "preserved");
    await symlink(outside, join(fixture.systemRoot, "etc/agent-boot"));
    const password = passwordHasher();
    await assert.rejects(
      customizeRaspberryPiOsTrixie(fixture.options({ passwordHasher: password.hasher })),
      error => error instanceof RaspberryPiOsAdapterError && error.code === "unsafe-path",
    );
    assert.equal(await readFile(join(outside, "preserved"), "utf8"), "preserved");
    assert.deepEqual(await lstat(join(fixture.systemRoot, "etc/agent-boot")).then(status => status.isSymbolicLink()), true);
    await assert.rejects(readFile(join(fixture.boot, "userconf")));
  } finally {
    await fixture.cleanup();
  }
});

test("rejects runner bundle drift before partition discovery or image writes", async () => {
  const fixture = await createAdapterFixture();
  try {
    await writeFile(
      join(fixture.bundle, "root/opt/agent-boot/scripts/bin/agent-boot-runner"),
      "tampered\n",
    );
    const discovery = new FakePartitionDiscovery(fixture.partitions);
    await assert.rejects(
      customizeRaspberryPiOsTrixie(fixture.options({ partitionDiscovery: discovery })),
      error => error instanceof RaspberryPiOsAdapterError && error.code === "invalid-input",
    );
    assert.equal(discovery.calls, 0);
    await assert.rejects(readFile(join(fixture.boot, "userconf")));
  } finally {
    await fixture.cleanup();
  }
});

test("redacts failed password hashing diagnostics and writes no credential files", async () => {
  const fixture = await createAdapterFixture();
  try {
    const commands = new FakeCommandHost().scriptSpawnResult({
      output: [{ data: Buffer.from("fixture-account-password"), stream: "stderr" }],
      result: { exitCode: 1, reason: "exit", signal: null },
    });
    const hasher = new OpenSslPasswordHasher({ commandHost: commands });
    let caught;
    try {
      await customizeRaspberryPiOsTrixie(fixture.options({ passwordHasher: hasher }));
    } catch (error) {
      caught = error;
    }
    assert.ok(caught instanceof RaspberryPiOsAdapterError);
    assert.equal(caught.code, "password-hash-failed");
    assert.doesNotMatch(`${caught.name}:${caught.message}:${caught.stack}`, /fixture-account-password/u);
    assert.deepEqual(commands.spawnCalls[0].arguments, ["passwd", "-6", "-stdin"]);
    assert.doesNotMatch(JSON.stringify(commands.spawnCalls[0].arguments), /fixture-account-password/u);
    await assert.rejects(readFile(join(fixture.boot, "userconf")));
  } finally {
    await fixture.cleanup();
  }
});

import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import {
  chmod,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath, URL } from "node:url";

import { FakeCommandHost } from "@agent-boot/process";
import { buildRunnerBundle, inspectTree, treeSha256 } from "@agent-boot/runner-bundle";
import { OpenSslPasswordHasher } from "@agent-boot/os-adapters/raspberry-pi-os-trixie";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const imageFixture = join(
  repositoryRoot,
  "packages/os-adapters/fixtures/raspberry-pi-os-trixie/image-root",
);
const lockFixture = join(
  repositoryRoot,
  "packages/os-adapters/fixtures/raspberry-pi-os-lite-trixie-arm64.os-lock.json",
);
const assemblyFixture = join(repositoryRoot, "packages/synth/fixtures/assembly");
const sha = character => character.repeat(64);

const createArm64Elf = () => {
  const header = Buffer.alloc(64);
  Buffer.from([0x7f, 0x45, 0x4c, 0x46]).copy(header);
  header[4] = 2;
  header[5] = 1;
  header.writeUInt16LE(183, 18);
  return header;
};

const createRuntime = async root => {
  const runtime = join(root, "runtime");
  await mkdir(join(runtime, "bin"), { recursive: true });
  await mkdir(join(runtime, "include", "node"), { recursive: true });
  await writeFile(join(runtime, "bin", "node"), createArm64Elf());
  await chmod(join(runtime, "bin", "node"), 0o755);
  await writeFile(join(runtime, "include", "node", "node_version.h"), [
    "#define NODE_MAJOR_VERSION 24",
    "#define NODE_MINOR_VERSION 18",
    "#define NODE_PATCH_VERSION 0",
    "#define NODE_VERSION_IS_LTS 1",
    '#define NODE_VERSION_LTS_CODENAME "Krypton"',
    "",
  ].join("\n"));
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

const createAssembly = async root => {
  const assembly = join(root, "assembly");
  await cp(assemblyFixture, assembly, { recursive: true });
  await cp(lockFixture, join(assembly, "os-lock.json"));
  const manifestPath = join(assembly, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.bootstrap.account.initialPassword.secretId = "account-password";
  manifest.bootstrap.network = {
    hostname: "fixture-agent",
    wifi: { ssid: "fixture-network", passphrase: { secretId: "wifi-passphrase" } },
  };
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  const files = new Map([
    ["assets/runner/runtime", "runner-runtime\n"],
    ["assets/runner/entrypoint.mjs", "export {};\n"],
    ["assets/resources/agent-config", '{"enabled":true}\n'],
    ["assets/scripts/prepare", "#!/bin/sh\nexit 0\n"],
    ["prompts/bootstrap", "Hello {{agent-name}}\n"],
  ]);
  for (const [path, contents] of files) {
    await mkdir(join(assembly, path, ".."), { recursive: true });
    await writeFile(join(assembly, path), contents);
  }
  return assembly;
};

export class FakeOwnership {
  identities = new Map();

  async inspect(path) {
    return this.identities.get(path) ?? { gid: 0, uid: 0 };
  }

  async set(path, identity) {
    this.identities.set(path, { gid: identity.gid, uid: identity.uid });
  }
}

export class FakePartitionDiscovery {
  calls = 0;

  constructor(partitions) {
    this.partitions = partitions;
  }

  async discover() {
    this.calls += 1;
    return this.partitions.map(partition => ({ ...partition }));
  }
}

const hashOutput = salt => `$6$${salt}$${"a".repeat(86)}\n`;

export const passwordHasher = (scripts = 1) => {
  const commands = new FakeCommandHost();
  for (let index = 0; index < scripts; index += 1) {
    commands.scriptSpawnResult({
      output: [{ data: Buffer.from(hashOutput("fixturesalt")), stream: "stdout" }],
      result: { exitCode: 0, reason: "exit", signal: null },
    });
  }
  return { commands, hasher: new OpenSslPasswordHasher({ commandHost: commands }) };
};

export const createAdapterFixture = async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-boot-rpi-adapter-"));
  const image = join(root, "image");
  await cp(imageFixture, image, { recursive: true });
  const boot = join(image, "boot");
  const systemRoot = join(image, "root");
  const assembly = await createAssembly(root);
  const runtime = await createRuntime(root);
  const bundle = join(root, "bundle");
  const account = {
    gid: 1000,
    group: "my-user",
    homeDirectory: "/home/my-user",
    uid: 1000,
    username: "my-user",
    workingDirectory: "/home/my-user/workspace",
  };
  await buildRunnerBundle({
    account,
    node: runtime.pin,
    nodeRuntimeDirectory: runtime.runtime,
    outputDirectory: bundle,
  });
  const osLock = JSON.parse(await readFile(lockFixture, "utf8"));
  const partitions = [
    { filesystem: "fat32", label: "bootfs", mountPath: boot, role: "boot" },
    { filesystem: "ext4", label: "rootfs", mountPath: systemRoot, role: "root" },
  ];
  const ownership = new FakeOwnership();
  return {
    account,
    assembly,
    boot,
    bundle,
    cleanup: () => rm(root, { force: true, recursive: true }),
    options: (overrides = {}) => ({
      account,
      assemblyDirectory: assembly,
      bootstrapSecrets: new Map([
        ["account-password", Buffer.from("fixture-account-password")],
        ["credential", Buffer.from("fixture-runner-secret")],
        ["wifi-passphrase", Buffer.from("fixture-wifi-passphrase")],
      ]),
      osLock,
      ownership,
      partitionDiscovery: new FakePartitionDiscovery(partitions),
      runnerBundleDirectory: bundle,
      ...overrides,
    }),
    osLock,
    ownership,
    partitions,
    root,
    systemRoot,
  };
};

export const snapshotTree = async root => {
  const records = [];
  const visit = async path => {
    for (const name of await readdir(path)) {
      const absolute = join(path, name);
      const status = await lstat(absolute);
      const record = {
        kind: status.isDirectory() ? "directory" : status.isSymbolicLink() ? "symlink" : "file",
        mode: status.mode & 0o777,
        path: relative(root, absolute),
      };
      if (status.isDirectory()) {
        records.push(record);
        await visit(absolute);
      } else if (status.isSymbolicLink()) {
        records.push({ ...record, target: await readlink(absolute) });
      } else {
        records.push({
          ...record,
          sha256: createHash("sha256").update(await readFile(absolute)).digest("hex"),
        });
      }
    }
  };
  await visit(root);
  return records.sort((left, right) => left.path.localeCompare(right.path));
};

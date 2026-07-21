import { readSafeFile, loadInputs, readBundleFile } from "./source.js";
import { adapterError } from "./errors.js";
import { SafeImageWriter, type ImagePlanEntry } from "./filesystem.js";
import type {
  PostCustomizationAssertion,
  RaspberryPiOsCustomizationOptions,
  RaspberryPiOsCustomizationResult,
} from "./model.js";
import {
  assertNetworkConfig,
  renderNetworkConfig,
  renderNetworkManagerProfile,
} from "./network-config.js";
import { discoverImageRoots } from "./partitions.js";
import { createRootPlan, renderProtectedBootFstab, validateAccount } from "./plan.js";
import {
  SystemMountedFilesystemCapacityInspector,
  preflightImagePlanCapacity,
} from "./capacity.js";

const secretId = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/u;
const rootIdentity = { gid: 0, uid: 0 } as const;

const snapshotSecrets = (
  input: ReadonlyMap<string, Uint8Array>,
): ReadonlyMap<string, Uint8Array> => {
  const secrets = new Map<string, Uint8Array>();
  for (const [id, contents] of input) {
    if (!secretId.test(id) || contents.byteLength === 0 || contents.byteLength > 1_048_576) {
      throw adapterError("invalid-input", "A bootstrap secret input is invalid.");
    }
    secrets.set(id, Uint8Array.from(contents));
  }
  return secrets;
};

const requireSecret = (
  secrets: ReadonlyMap<string, Uint8Array>,
  id: string,
): Uint8Array => {
  const contents = secrets.get(id);
  if (contents === undefined) throw adapterError("invalid-input", "A required bootstrap secret is missing.");
  return contents;
};

const existingPasswordHash = (contents: Uint8Array | undefined, username: string): string | undefined => {
  if (contents === undefined) return undefined;
  const line = Buffer.from(contents).toString("utf8").trimEnd();
  const separator = line.indexOf(":");
  if (separator <= 0 || line.slice(0, separator) !== username || line.includes("\n")) {
    throw adapterError("incompatible-image", "The existing account bootstrap is incompatible.");
  }
  return line.slice(separator + 1);
};

const validateExistingAccountFiles = (
  passwd: Uint8Array,
  group: Uint8Array,
  username: string,
): void => {
  const passwdEntries = Buffer.from(passwd).toString("utf8").trimEnd().split("\n")
    .map((line) => line.split(":"));
  const groupEntries = Buffer.from(group).toString("utf8").trimEnd().split("\n")
    .map((line) => line.split(":"));
  const uidEntries = passwdEntries.filter((entry) => entry[2] === "1000");
  const gidEntries = groupEntries.filter((entry) => entry[2] === "1000");
  const targetPasswdEntries = passwdEntries.filter((entry) => entry[0] === username);
  const targetGroupEntries = groupEntries.filter((entry) => entry[0] === username);
  const uidEntry = uidEntries[0];
  const gidEntry = gidEntries[0];
  const acceptedName = uidEntry?.[0];
  if (
    uidEntries.length !== 1 || gidEntries.length !== 1 || uidEntry === undefined || gidEntry === undefined ||
    uidEntry[3] !== "1000" || gidEntry[0] !== acceptedName ||
    (acceptedName !== "pi" && acceptedName !== username) ||
    targetPasswdEntries.some((entry) => entry[2] !== "1000" || entry[3] !== "1000") ||
    targetGroupEntries.some((entry) => entry[2] !== "1000")
  ) throw adapterError("incompatible-image", "The image first-user identity is incompatible.");
};

const bootPlan = (
  userconf: Uint8Array,
  networkConfig: Uint8Array | undefined,
): readonly ImagePlanEntry[] => [
  { contents: userconf, identity: rootIdentity, kind: "file", mode: 0o600, path: "userconf" },
  { contents: new Uint8Array(), identity: rootIdentity, kind: "file", mode: 0o600, path: "ssh" },
  ...(networkConfig === undefined ? [] : [{
    contents: networkConfig,
    identity: rootIdentity,
    kind: "file" as const,
    mode: 0o600,
    path: "network-config",
  }]),
];

const assertion = (id: string, path: string): PostCustomizationAssertion => ({
  id,
  path,
  status: "passed",
});

export const customizeRaspberryPiOsTrixie = async (
  options: RaspberryPiOsCustomizationOptions,
): Promise<RaspberryPiOsCustomizationResult> => {
  const secrets = snapshotSecrets(options.bootstrapSecrets);
  const inputs = await loadInputs(
    options.assemblyDirectory,
    options.runnerBundleDirectory,
    options.osLock,
  );
  validateAccount(inputs.assembly.documents.manifest, options.account);
  const roots = await discoverImageRoots(options.partitionDiscovery, inputs.osLock);
  const [bootWriter, rootWriter, passwd, group, hosts, fstab] = await Promise.all([
    SafeImageWriter.create(roots.boot.path, options.ownership, roots.boot.metadata),
    SafeImageWriter.create(roots.root.path, options.ownership, roots.root.metadata),
    readSafeFile(roots.root.path, "etc/passwd"),
    readSafeFile(roots.root.path, "etc/group"),
    readSafeFile(roots.root.path, "etc/hosts"),
    readSafeFile(roots.root.path, "etc/fstab"),
  ]);
  validateExistingAccountFiles(passwd, group, options.account.username);
  const protectedBootFstab = renderProtectedBootFstab(fstab);

  const accountReference = inputs.assembly.documents.manifest.bootstrap.account.initialPassword;
  const existing = existingPasswordHash(await bootWriter.readOptional("userconf"), options.account.username);
  let accountHash = "!";
  if (accountReference !== undefined) {
    if (options.passwordHasher === undefined) {
      throw adapterError("invalid-input", "Account password hashing is not configured.");
    }
    accountHash = await options.passwordHasher.hash(
      requireSecret(secrets, accountReference.secretId),
      existing === "!" ? undefined : existing,
    );
  }
  const userconf = Buffer.from(`${options.account.username}:${accountHash}\n`, "utf8");

  const network = inputs.assembly.documents.manifest.bootstrap.network;
  const wifi = network?.wifi === undefined ? undefined : {
    passphrase: requireSecret(secrets, network.wifi.passphrase.secretId),
    ssid: network.wifi.ssid,
  };
  const networkConfig = wifi === undefined ? undefined : renderNetworkConfig(wifi);
  const networkManagerProfile = wifi === undefined
    ? undefined
    : renderNetworkManagerProfile(wifi);
  const bootEntries = bootPlan(userconf, networkConfig);
  const rootEntries = await createRootPlan(
    inputs.assembly,
    inputs.bundle,
    (path) => readBundleFile(options.runnerBundleDirectory, path),
    options.account,
    secrets,
    networkManagerProfile,
    network?.hostname,
    hosts,
    protectedBootFstab,
  );

  await Promise.all([bootWriter.preflight(bootEntries), rootWriter.preflight(rootEntries)]);
  const capacityInspector = options.capacityInspector ?? new SystemMountedFilesystemCapacityInspector();
  await preflightImagePlanCapacity("boot", roots.boot.path, bootEntries, capacityInspector);
  await preflightImagePlanCapacity("root", roots.root.path, rootEntries, capacityInspector);
  await rootWriter.apply(rootEntries);
  await bootWriter.apply(bootEntries);
  await Promise.all([bootWriter.verify(bootEntries), rootWriter.verify(rootEntries)]);
  if (wifi !== undefined && networkConfig !== undefined) assertNetworkConfig(networkConfig, wifi);

  const assertions = [
    assertion("partition-contract", "/boot/firmware + /"),
    assertion("bootfs-root-only", "/boot/firmware"),
    assertion("bootfs-runtime-mount", "/etc/fstab"),
    assertion("account-bootstrap", "/boot/firmware/userconf"),
    assertion("ssh-bootstrap", "/boot/firmware/ssh"),
    ...(wifi === undefined ? [] : [assertion("netplan-v2", "/boot/firmware/network-config")]),
    ...(wifi === undefined ? [] : [assertion(
      "network-manager-wifi",
      "/etc/NetworkManager/system-connections/agent-boot-wifi.nmconnection",
    )]),
    assertion("runner-layout", "/opt/agent-boot"),
    assertion("runner-documents", "/etc/agent-boot"),
    assertion("bootstrap-secret-modes", "/etc/agent-boot/bootstrap-secrets"),
    assertion("console-service", "/etc/systemd/system/agent-boot-runner.service"),
    assertion("console-ownership", "/etc/systemd/system/getty@tty1.service"),
    assertion("recovery-console", "/etc/systemd/system/getty.target.wants/getty@tty2.service"),
    assertion("persistent-journal", "/etc/systemd/journald.conf.d/20-agent-boot.conf"),
    assertion("service-enabled", "/etc/systemd/system/multi-user.target.wants/agent-boot-runner.service"),
  ];
  return {
    assertions,
    assemblyId: inputs.assembly.documents.manifest.assemblyId,
    catalogId: inputs.osLock.catalogId,
  };
};

import { readSafeFile, loadInputs, readBundleFile } from "./source.js";
import { adapterError } from "./errors.js";
import { SafeImageWriter, type ImagePlanEntry } from "./filesystem.js";
import type {
  PostCustomizationAssertion,
  RaspberryPiOsCustomizationOptions,
  RaspberryPiOsCustomizationResult,
} from "./model.js";
import { assertNetworkConfig, renderNetworkConfig } from "./network-config.js";
import { discoverImageRoots } from "./partitions.js";
import { createRootPlan, validateAccount } from "./plan.js";

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
  const passwdEntries = Buffer.from(passwd).toString("utf8").trimEnd().split("\n");
  const groupEntries = Buffer.from(group).toString("utf8").trimEnd().split("\n");
  const uidEntry = passwdEntries.find((line) => line.split(":")[2] === "1000");
  const gidEntry = groupEntries.find((line) => line.split(":")[2] === "1000");
  if (
    (uidEntry !== undefined && uidEntry.split(":")[0] !== username) ||
    (gidEntry !== undefined && gidEntry.split(":")[0] !== username)
  ) throw adapterError("incompatible-image", "The image first-user identity is already occupied.");
};

const bootPlan = (
  userconf: Uint8Array,
  networkConfig: Uint8Array | undefined,
): readonly ImagePlanEntry[] => [
  { contents: userconf, identity: rootIdentity, kind: "file", mode: 0o600, path: "userconf" },
  { contents: new Uint8Array(), identity: rootIdentity, kind: "file", mode: 0o644, path: "ssh" },
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
  const [bootWriter, rootWriter, passwd, group, hosts] = await Promise.all([
    SafeImageWriter.create(roots.boot, options.ownership),
    SafeImageWriter.create(roots.root, options.ownership),
    readSafeFile(roots.root, "etc/passwd"),
    readSafeFile(roots.root, "etc/group"),
    readSafeFile(roots.root, "etc/hosts"),
  ]);
  validateExistingAccountFiles(passwd, group, options.account.username);

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
  const bootEntries = bootPlan(userconf, networkConfig);
  const rootEntries = await createRootPlan(
    inputs.assembly,
    inputs.bundle,
    (path) => readBundleFile(options.runnerBundleDirectory, path),
    options.account,
    secrets,
    network?.hostname,
    hosts,
  );

  await Promise.all([bootWriter.preflight(bootEntries), rootWriter.preflight(rootEntries)]);
  await bootWriter.apply(bootEntries);
  await rootWriter.apply(rootEntries);
  await Promise.all([bootWriter.verify(bootEntries), rootWriter.verify(rootEntries)]);
  if (wifi !== undefined && networkConfig !== undefined) assertNetworkConfig(networkConfig, wifi);

  const assertions = [
    assertion("partition-contract", "/boot/firmware + /"),
    assertion("account-bootstrap", "/boot/firmware/userconf"),
    assertion("ssh-bootstrap", "/boot/firmware/ssh"),
    ...(wifi === undefined ? [] : [assertion("netplan-v2", "/boot/firmware/network-config")]),
    assertion("runner-layout", "/opt/agent-boot"),
    assertion("runner-documents", "/etc/agent-boot"),
    assertion("bootstrap-secret-modes", "/etc/agent-boot/bootstrap-secrets"),
    assertion("console-service", "/etc/systemd/system/agent-boot-runner.service"),
    assertion("service-enabled", "/etc/systemd/system/multi-user.target.wants/agent-boot-runner.service"),
  ];
  return {
    assertions,
    assemblyId: inputs.assembly.documents.manifest.assemblyId,
    catalogId: inputs.osLock.catalogId,
  };
};

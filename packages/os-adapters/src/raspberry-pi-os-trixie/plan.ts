import type { AssemblyManifest, RunnerPlan } from "@agent-boot/protocol";
import {
  BUNDLE_ROOT_PATH,
  targetPathForBundleEntry,
  type RunnerBundleManifest,
} from "@agent-boot/runner-bundle";

import { adapterError } from "./errors.js";
import type { ImagePlanEntry } from "./filesystem.js";
import type { ImageIdentity, RaspberryPiAccount } from "./model.js";
import type { LoadedAssembly } from "./source.js";

export interface ImagePlans {
  readonly boot: readonly ImagePlanEntry[];
  readonly root: readonly ImagePlanEntry[];
}

const rootIdentity: ImageIdentity = { gid: 0, uid: 0 };
const networkManagerEnabledState = Buffer.from([
  "[main]",
  "NetworkingEnabled=true",
  "WirelessEnabled=true",
  "WWANEnabled=true",
  "",
].join("\n"), "utf8");
const persistentJournalConfig = Buffer.from([
  "[Journal]",
  "Storage=persistent",
  "SystemMaxUse=64M",
  "SystemKeepFree=64M",
  "MaxRetentionSec=7day",
  "",
].join("\n"), "utf8");

const userShellPathProfile = Buffer.from([
  "case \":$PATH:\" in",
  "  *:/opt/agent-boot/runtime/bin:*) ;;",
  "  *) PATH=\"/opt/agent-boot/runtime/bin:$PATH\" ;;",
  "esac",
  "case \":$PATH:\" in",
  "  *:\"$HOME/.local/bin\":*) ;;",
  "  *) PATH=\"$HOME/.local/bin:$PATH\" ;;",
  "esac",
  "export PATH",
  "",
].join("\n"), "utf8");

const relativeTarget = (path: string): string => path.slice(1);

class Plan {
  readonly #entries = new Map<string, ImagePlanEntry>();

  add(entry: ImagePlanEntry): void {
    for (const existing of this.#entries.values()) {
      if (
        (entry.path.startsWith(`${existing.path}/`) && existing.kind !== "directory") ||
        (existing.path.startsWith(`${entry.path}/`) && entry.kind !== "directory")
      ) throw adapterError("invalid-input", "Target placement ancestry conflicts.");
    }
    const existing = this.#entries.get(entry.path);
    if (existing === undefined) {
      this.#entries.set(entry.path, entry);
      return;
    }
    if (existing.kind !== entry.kind) throw adapterError("invalid-input", "Target placements conflict.");
    if (entry.kind === "directory" && existing.kind === "directory") {
      if (
        existing.mode !== entry.mode || existing.identity.uid !== entry.identity.uid ||
        existing.identity.gid !== entry.identity.gid
      ) throw adapterError("invalid-input", "Target directory contracts conflict.");
      return;
    }
    throw adapterError("invalid-input", "Target file placements conflict.");
  }

  directory(path: string, mode: number, identity: ImageIdentity): void {
    const segments = path.split("/");
    for (let index = 1; index <= segments.length; index += 1) {
      const parent = segments.slice(0, index).join("/");
      const isLeaf = index === segments.length;
      if (!isLeaf && this.#entries.has(parent)) continue;
      this.add({
        identity: isLeaf ? identity : rootIdentity,
        kind: "directory",
        mode: isLeaf ? mode : 0o755,
        path: parent,
      });
    }
  }

  parents(path: string): void {
    const segments = path.split("/");
    for (let index = 1; index < segments.length; index += 1) {
      const parent = segments.slice(0, index).join("/");
      if (!this.#entries.has(parent)) {
        this.add({ identity: rootIdentity, kind: "directory", mode: 0o755, path: parent });
      }
    }
  }

  file(path: string, contents: Uint8Array, mode: number, identity: ImageIdentity): void {
    this.parents(path);
    this.add({ contents, identity, kind: "file", mode, path });
  }

  link(path: string, linkTarget: string, identity: ImageIdentity): void {
    this.parents(path);
    this.add({ identity, kind: "symlink", linkTarget, path });
  }

  values(): readonly ImagePlanEntry[] {
    return [...this.#entries.values()];
  }
}

const assetMode = (path: string): number => path.startsWith("assets/scripts/") ? 0o755 : 0o644;

const assemblyFile = (assembly: LoadedAssembly, path: string): Uint8Array => {
  const contents = assembly.files.get(path);
  if (contents === undefined) throw adapterError("invalid-input", "An assembly file is missing.");
  return contents;
};

const accountOwnedBundlePath = (target: string): boolean =>
  target === "/etc/agent-boot/bootstrap-secrets" ||
  target === "/var/lib/agent-boot" || target.startsWith("/var/lib/agent-boot/") ||
  target === "/run/agent-boot" || target.startsWith("/run/agent-boot/");

const requiredRunnerSecrets = (plan: RunnerPlan): ReadonlySet<string> => {
  const ids = new Set<string>();
  for (const step of plan.steps) {
    if (step.kind === "install-user-secret") ids.add(step.secretId);
    if (step.kind === "prompt") {
      for (const variable of step.variables) {
        if (variable.source.kind === "secret") ids.add(variable.source.secretId);
      }
    }
  }
  return ids;
};

const validateServiceAccount = (
  contents: Uint8Array,
  account: RaspberryPiAccount,
): void => {
  const lines = new Set(Buffer.from(contents).toString("utf8").split("\n"));
  const npmPrefix = `${account.homeDirectory}/.local`;
  for (const expected of [
    `User=${account.username}`,
    `Group=${account.group}`,
    `Environment=HOME=${account.homeDirectory}`,
    `Environment=NPM_CONFIG_PREFIX=${npmPrefix}`,
    `WorkingDirectory=${account.workingDirectory}`,
    "TTYPath=/dev/tty1",
    "StandardInput=tty-force",
  ]) {
    if (!lines.has(expected)) {
      throw adapterError("incompatible-image", "The runner service account contract does not match.");
    }
  }
};

export const createRootPlan = async (
  assembly: LoadedAssembly,
  bundle: RunnerBundleManifest,
  bundleFile: (path: string) => Promise<Uint8Array>,
  account: RaspberryPiAccount,
  secrets: ReadonlyMap<string, Uint8Array>,
  networkManagerProfile: Uint8Array | undefined,
  hostname: string | undefined,
  hostsContents: Uint8Array,
  protectedBootFstab: Uint8Array,
): Promise<readonly ImagePlanEntry[]> => {
  const plan = new Plan();
  for (const entry of bundle.entries) {
    const target = targetPathForBundleEntry(entry.path);
    const path = relativeTarget(target);
    const identity = target === "/etc/agent-boot"
      ? { gid: account.gid, uid: 0 }
      : accountOwnedBundlePath(target) ? account : rootIdentity;
    if (entry.kind === "directory") plan.directory(path, Number.parseInt(entry.mode, 8), identity);
    else if (entry.kind === "file") {
      const contents = await bundleFile(entry.path);
      plan.file(path, contents, Number.parseInt(entry.mode, 8), identity);
      if (target === "/etc/systemd/system/agent-boot-runner.service") {
        validateServiceAccount(contents, account);
      }
    } else plan.link(path, entry.linkTarget, identity);
  }
  if (!bundle.entries.some((entry) => entry.path === `${BUNDLE_ROOT_PATH}/opt/agent-boot/runtime/bin/node`)) {
    throw adapterError("invalid-input", "The runner bundle has no private ARM64 Node runtime.");
  }

  plan.directory(account.homeDirectory.slice(1), 0o750, account);
  plan.directory(account.workingDirectory.slice(1), 0o750, account);
  plan.directory(`${account.homeDirectory.slice(1)}/.local`, 0o750, account);
  plan.directory(`${account.homeDirectory.slice(1)}/.local/bin`, 0o750, account);
  plan.directory(`${account.homeDirectory.slice(1)}/.local/lib`, 0o750, account);
  plan.directory(`${account.homeDirectory.slice(1)}/.npm`, 0o700, account);
  plan.file(`${account.homeDirectory.slice(1)}/.profile`, userShellPathProfile, 0o644, account);
  plan.file(`${account.homeDirectory.slice(1)}/.bashrc`, userShellPathProfile, 0o644, account);
  plan.file(
    `${account.homeDirectory.slice(1)}/.npmrc`,
    Buffer.from(`prefix=${account.homeDirectory}/.local\n`, "utf8"),
    0o600,
    account,
  );
  plan.file("etc/agent-boot/manifest.json", assemblyFile(assembly, "manifest.json"), 0o644, rootIdentity);
  plan.file("etc/agent-boot/plan.json", assemblyFile(assembly, "runner-plan.json"), 0o644, rootIdentity);
  for (const prompt of assembly.documents.manifest.prompts) {
    plan.file(`opt/agent-boot/${prompt.path}`, assemblyFile(assembly, prompt.path), 0o644, rootIdentity);
  }
  for (const asset of assembly.documents.manifest.assets) {
    const contents = assemblyFile(assembly, asset.path);
    plan.file(`opt/agent-boot/${asset.path}`, contents, assetMode(asset.path), rootIdentity);
    if (
      asset.placement === undefined ||
      asset.id === assembly.documents.manifest.bootstrap.runnerInstallation.runtimeAssetId ||
      asset.id === assembly.documents.manifest.bootstrap.runnerInstallation.entrypointAssetId
    ) continue;
    const target = asset.placement.scope === "system"
      ? asset.placement.path
      : `${account.homeDirectory.slice(1)}/${asset.placement.path}`;
    const identity = asset.placement.scope === "system" ? rootIdentity : account;
    plan.file(target, contents, asset.placement.scope === "user-home" ? 0o600 : assetMode(asset.path), identity);
  }

  plan.directory("etc/agent-boot/bootstrap-secrets", 0o700, account);
  for (const secretId of requiredRunnerSecrets(assembly.documents.runnerPlan)) {
    const contents = secrets.get(secretId);
    if (contents === undefined) throw adapterError("invalid-input", "A required bootstrap secret is missing.");
    plan.file(`etc/agent-boot/bootstrap-secrets/${secretId}`, contents, 0o600, account);
  }
  plan.file(
    "etc/ssh/sshd_config.d/20-agent-boot.conf",
    Buffer.from([
      "PermitRootLogin no",
      "PubkeyAuthentication yes",
      `PasswordAuthentication ${assembly.documents.manifest.bootstrap.account.initialPassword === undefined ? "no" : "yes"}`,
      "",
    ].join("\n"), "utf8"),
    0o644,
    rootIdentity,
  );
  plan.file("etc/fstab", protectedBootFstab, 0o644, rootIdentity);
  plan.file("var/lib/NetworkManager/NetworkManager.state", networkManagerEnabledState, 0o644, rootIdentity);
  if (networkManagerProfile !== undefined) {
    plan.file(
      "etc/NetworkManager/system-connections/agent-boot-wifi.nmconnection",
      networkManagerProfile,
      0o600,
      rootIdentity,
    );
  }
  plan.file(
    "etc/systemd/journald.conf.d/20-agent-boot.conf",
    persistentJournalConfig,
    0o644,
    rootIdentity,
  );
  plan.link("etc/systemd/system/getty@tty1.service", "/dev/null", rootIdentity);
  plan.link(
    "etc/systemd/system/getty.target.wants/getty@tty2.service",
    "/lib/systemd/system/getty@.service",
    rootIdentity,
  );
  plan.link(
    "etc/systemd/system/multi-user.target.wants/agent-boot-runner.service",
    "../agent-boot-runner.service",
    rootIdentity,
  );
  if (hostname !== undefined) {
    plan.file("etc/hostname", Buffer.from(`${hostname}\n`, "utf8"), 0o644, rootIdentity);
    plan.file("etc/hosts", renderHosts(hostsContents, hostname), 0o644, rootIdentity);
  }
  return plan.values();
};

const protectedBootOptions = ["uid=0", "gid=0", "fmask=0177", "dmask=0077"] as const;

export const renderProtectedBootFstab = (input: Uint8Array): Uint8Array => {
  const lines = Buffer.from(input).toString("utf8").trimEnd().split("\n");
  const matches = lines.flatMap((line, index) => {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) return [];
    const fields = trimmed.split(/\s+/u);
    return fields[1] === "/boot/firmware" ? [{ fields, index }] : [];
  });
  const match = matches[0];
  if (matches.length !== 1 || match === undefined || match.fields.length < 6 || match.fields[2] !== "vfat") {
    throw adapterError("incompatible-image", "The boot filesystem table entry is incompatible.");
  }
  const options = match.fields[3]?.split(",") ?? [];
  const retained = options.filter((option) =>
    !/^(?:uid|gid|umask|fmask|dmask)=/u.test(option));
  match.fields[3] = [...retained, ...protectedBootOptions].join(",");
  lines[match.index] = match.fields.join("\t");
  return Buffer.from(`${lines.join("\n")}\n`, "utf8");
};

const renderHosts = (input: Uint8Array, hostname: string): Uint8Array => {
  const lines = Buffer.from(input).toString("utf8").trimEnd().split("\n");
  const index = lines.findIndex((line) => /^127\.0\.1\.1(?:\s|$)/u.test(line));
  const hostLine = `127.0.1.1\t${hostname}`;
  if (index === -1) lines.push(hostLine);
  else lines[index] = hostLine;
  return Buffer.from(`${lines.join("\n")}\n`, "utf8");
};

export const validateAccount = (
  manifest: AssemblyManifest,
  account: RaspberryPiAccount,
): void => {
  const username = manifest.bootstrap.account.username;
  if (
    !/^[a-z][a-z0-9-]*$/u.test(username) ||
    account.username !== username || account.group !== username ||
    account.homeDirectory !== `/home/${username}` ||
    !account.workingDirectory.startsWith(`${account.homeDirectory}/`) ||
    account.uid !== 1000 || account.gid !== 1000
  ) throw adapterError("invalid-input", "The Raspberry Pi first-user account contract is invalid.");
};

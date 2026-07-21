import { posix } from "node:path";

export const BUNDLE_MANIFEST_PATH = "manifest.json";
export const BUNDLE_ROOT_PATH = "root";
export const RUNNER_SERVICE_NAME = "agent-boot-runner.service";
export const NETWORK_COMMAND_PATH = "/usr/local/sbin/agent-boot-network";
export const TARGET_PATHS = {
  assemblyManifest: "/etc/agent-boot/manifest.json",
  bootstrapSecrets: "/etc/agent-boot/bootstrap-secrets",
  config: "/etc/agent-boot",
  ephemeral: "/run/agent-boot",
  ephemeralPrompts: "/run/agent-boot/prompts",
  ephemeralSecrets: "/run/agent-boot/secrets",
  immutableRoot: "/opt/agent-boot",
  networkCommand: NETWORK_COMMAND_PATH,
  plan: "/etc/agent-boot/plan.json",
  persistent: "/var/lib/agent-boot",
  prompts: "/opt/agent-boot/prompts",
  assets: "/opt/agent-boot/assets",
  runtime: "/opt/agent-boot/runtime",
  scripts: "/opt/agent-boot/scripts",
  serviceStatus: "/var/lib/agent-boot/service-status.json",
  state: "/var/lib/agent-boot/state.json",
  systemdUnit: `/etc/systemd/system/${RUNNER_SERVICE_NAME}`,
  tty: "/dev/tty1",
} as const;

export const bundlePathForTarget = (targetPath: string): string => {
  if (
    targetPath === "/" || !targetPath.startsWith("/") ||
    targetPath.includes("\\") || targetPath.includes("\0") ||
    posix.normalize(targetPath) !== targetPath
  ) {
    throw new Error("Target paths must be normalized absolute paths beneath the filesystem root.");
  }
  return `${BUNDLE_ROOT_PATH}${targetPath}`;
};

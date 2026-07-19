import type { BlockDevice, DriveSnapshot } from "@agent-boot/os-linux";

import { isActiveRootAncestor, mountedDescendants } from "./topology.js";

export interface DriveCandidate {
  readonly canonicalPath: string;
  readonly model: string;
  readonly removable: boolean;
  readonly safetyWarnings: readonly string[];
  readonly serial: "[redacted]" | "unavailable";
  readonly sizeBytes: number;
  readonly stableTargets: readonly string[];
  readonly transport: string;
}

const linksFor = (device: BlockDevice, snapshot: DriveSnapshot): string[] =>
  snapshot.stableLinks
    .filter((link) => link.resolvedPath === device.canonicalPath)
    .map((link) => link.path)
    .sort((left, right) => left.localeCompare(right));

export const listDriveCandidates = (snapshot: DriveSnapshot): DriveCandidate[] =>
  snapshot.devices
    .filter((device) => device.type === "disk")
    .map((device): DriveCandidate => {
      const stableTargets = linksFor(device, snapshot);
      const safetyWarnings = [
        ...(isActiveRootAncestor(device, snapshot) ? ["active system disk"] : []),
        ...(mountedDescendants(device, snapshot).length > 0 ? ["mounted descendants"] : []),
        ...(!device.removable ? ["not removable"] : []),
        ...(stableTargets.length === 0 ? ["no stable by-id target"] : []),
      ];
      return {
        canonicalPath: device.canonicalPath,
        model: device.model ?? "unavailable",
        removable: device.removable,
        safetyWarnings,
        serial: device.serial === undefined ? "unavailable" : "[redacted]",
        sizeBytes: device.sizeBytes,
        stableTargets,
        transport: device.transport ?? "unavailable",
      };
    })
    .sort((left, right) => left.canonicalPath.localeCompare(right.canonicalPath));

const formatBytes = (bytes: number): string => {
  const gibibytes = bytes / (1024 ** 3);
  return `${gibibytes.toFixed(gibibytes >= 10 ? 1 : 2)} GiB`;
};

export const formatDriveCandidates = (candidates: readonly DriveCandidate[]): string[] => {
  if (candidates.length === 0) return ["No whole-disk devices were reported."];
  return candidates.flatMap((candidate, index) => [
    ...(index === 0 ? [] : [""]),
    `${candidate.canonicalPath} — ${formatBytes(candidate.sizeBytes)}`,
    `  model: ${candidate.model}`,
    `  serial: ${candidate.serial}`,
    `  transport: ${candidate.transport}`,
    `  removable: ${candidate.removable ? "yes" : "no"}`,
    ...(candidate.stableTargets.length === 0
      ? ["  stable target: unavailable"]
      : candidate.stableTargets.map((path) => `  stable target: ${path}`)),
    `  safety: ${candidate.safetyWarnings.length === 0
      ? "candidate; image preflight still required"
      : `blocked (${candidate.safetyWarnings.join(", ")})`}`,
  ]);
};

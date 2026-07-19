import type { DriveInspector } from "@agent-boot/os-linux";

import type { CommandIo } from "../validate-command.js";
import { formatDriveCandidates, listDriveCandidates } from "./list.js";

export const runDrivesListCommand = async (
  inspector: DriveInspector,
  io: CommandIo,
): Promise<0 | 8> => {
  try {
    const candidates = listDriveCandidates(await inspector.inspect());
    for (const line of formatDriveCandidates(candidates)) io.stdout(line);
    return 0;
  } catch {
    io.stderr("Drive inspection failed before any device operation was attempted.");
    return 8;
  }
};

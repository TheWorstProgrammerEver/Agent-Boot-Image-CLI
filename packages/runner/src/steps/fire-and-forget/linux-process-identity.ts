import { readdir, readFile } from "node:fs/promises";
import { setTimeout as wait } from "node:timers/promises";

import type { ProcessIdentity } from "../../state/index.js";
import type { ProcessIdentityHost } from "./model.js";

const BOOT_ID_PATH = "/proc/sys/kernel/random/boot_id";
const PROC_PATH = "/proc";
const bootIdPattern = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u;
const processIdPattern = /^[1-9][0-9]*$/u;

const missingProcess = (error: unknown): boolean =>
  (error as NodeJS.ErrnoException).code === "ENOENT" ||
  (error as NodeJS.ErrnoException).code === "ESRCH";

const processGroupExists = (processGroupId: number): boolean => {
  try {
    process.kill(-processGroupId, 0);
    return true;
  } catch (error) {
    if (missingProcess(error)) return false;
    throw error;
  }
};

const parseStatFields = (contents: string): {
  fields: readonly string[];
  processGroupId: number;
  running: boolean;
} => {
  const commandEnd = contents.lastIndexOf(")");
  if (commandEnd < 0) throw new Error("Linux process stat has no command terminator");
  const fields = contents.slice(commandEnd + 2).trim().split(/\s+/u);
  const processGroupId = Number(fields[2]);
  if (!Number.isSafeInteger(processGroupId) || processGroupId < 0) {
    throw new Error("Linux process stat has an invalid process group");
  }
  return {
    fields,
    processGroupId,
    running: fields[0] !== "Z" && fields[0] !== "X" && fields[0] !== "x",
  };
};

const parseStat = (contents: string): {
  processGroupId: number;
  running: boolean;
  startTimeTicks: string;
} => {
  const { fields, processGroupId, running } = parseStatFields(contents);
  const startTimeTicks = fields[19];
  if (
    processGroupId < 2 ||
    startTimeTicks === undefined ||
    !/^[1-9][0-9]*$/u.test(startTimeTicks)
  ) {
    throw new Error("Linux process stat has invalid identity fields");
  }
  return { processGroupId, running, startTimeTicks };
};

const processGroupHasRunningMember = async (processGroupId: number): Promise<boolean> => {
  const processIds = (await readdir(PROC_PATH)).filter((entry) => processIdPattern.test(entry));
  const members = await Promise.all(processIds.map(async (pid) => {
    try {
      const stat = parseStatFields(await readFile(`${PROC_PATH}/${pid}/stat`, "utf8"));
      return stat.processGroupId === processGroupId && stat.running;
    } catch (error) {
      if (missingProcess(error)) return false;
      throw error;
    }
  }));
  return members.includes(true);
};

const sameIdentity = (left: ProcessIdentity, right: ProcessIdentity): boolean =>
  left.bootId === right.bootId &&
  left.pid === right.pid &&
  left.processGroupId === right.processGroupId &&
  left.startTimeTicks === right.startTimeTicks;

export class LinuxProcessIdentityHost implements ProcessIdentityHost {
  #bootId: Promise<string> | undefined;

  async capture(pid: number): Promise<ProcessIdentity | undefined> {
    if (!Number.isSafeInteger(pid) || pid < 2) return undefined;
    try {
      const [bootId, stat] = await Promise.all([
        this.#readBootId(),
        readFile(`/proc/${String(pid)}/stat`, "utf8"),
      ]);
      const parsed = parseStat(stat);
      return parsed.running
        ? {
            bootId,
            pid,
            processGroupId: parsed.processGroupId,
            startTimeTicks: parsed.startTimeTicks,
          }
        : undefined;
    } catch (error) {
      if (missingProcess(error)) return undefined;
      throw error;
    }
  }

  currentBootId(): Promise<string> {
    return this.#readBootId();
  }

  async matches(identity: ProcessIdentity): Promise<boolean> {
    const current = await this.capture(identity.pid);
    return current !== undefined && sameIdentity(current, identity);
  }

  async terminate(
    identity: ProcessIdentity,
    signal: NodeJS.Signals,
    graceMs: number,
  ): Promise<boolean> {
    if (!(await this.matches(identity))) return true;
    try {
      process.kill(-identity.processGroupId, signal);
    } catch (error) {
      if (missingProcess(error)) return true;
      throw error;
    }
    if (await this.#waitForGroupExit(identity.processGroupId, graceMs)) return true;
    try {
      process.kill(-identity.processGroupId, "SIGKILL");
    } catch (error) {
      if (missingProcess(error)) return true;
      throw error;
    }
    return this.#waitForGroupExit(identity.processGroupId, graceMs);
  }

  async #readBootId(): Promise<string> {
    this.#bootId ??= readFile(BOOT_ID_PATH, "utf8").then((contents) => {
      const bootId = contents.trim();
      if (!bootIdPattern.test(bootId)) throw new Error("Linux boot ID is invalid");
      return bootId;
    });
    return this.#bootId;
  }

  async #waitForGroupExit(processGroupId: number, graceMs: number): Promise<boolean> {
    const deadline = Date.now() + graceMs;
    while (Date.now() < deadline) {
      if (!processGroupExists(processGroupId)) return true;
      await wait(Math.min(10, Math.max(1, deadline - Date.now())));
    }
    return !processGroupExists(processGroupId) ||
      !(await processGroupHasRunningMember(processGroupId));
  }
}

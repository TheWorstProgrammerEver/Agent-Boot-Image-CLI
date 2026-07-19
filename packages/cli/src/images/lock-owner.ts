import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

interface ProcessBirthIdentity {
  readonly bootId: string;
  readonly pid: number;
  readonly startTimeTicks: string;
}

interface LockOwner extends ProcessBirthIdentity {
  readonly token: string;
  readonly version: 1;
}

const bootIdPattern = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u;
const positiveIntegerPattern = /^[1-9][0-9]*$/u;
let localProcessBirth: Promise<ProcessBirthIdentity> | undefined;

const missingProcess = (error: unknown): boolean =>
  (error as NodeJS.ErrnoException).code === "ENOENT" ||
  (error as NodeJS.ErrnoException).code === "ESRCH";

const parseStartTime = (contents: string): string | undefined => {
  const commandEnd = contents.lastIndexOf(")");
  if (commandEnd < 0) return undefined;
  const fields = contents.slice(commandEnd + 2).trim().split(/\s+/u);
  const startTimeTicks = fields[19];
  if (
    fields[0] === "Z" ||
    fields[0] === "X" ||
    fields[0] === "x" ||
    startTimeTicks === undefined ||
    !positiveIntegerPattern.test(startTimeTicks)
  ) return undefined;
  return startTimeTicks;
};

const captureProcessBirth = async (pid: number): Promise<ProcessBirthIdentity | undefined> => {
  try {
    const [bootIdContents, stat] = await Promise.all([
      readFile("/proc/sys/kernel/random/boot_id", "utf8"),
      readFile(`/proc/${String(pid)}/stat`, "utf8"),
    ]);
    const bootId = bootIdContents.trim();
    const startTimeTicks = parseStartTime(stat);
    if (!bootIdPattern.test(bootId) || startTimeTicks === undefined) return undefined;
    return { bootId, pid, startTimeTicks };
  } catch (error) {
    if (missingProcess(error)) return undefined;
    throw error;
  }
};

const parseOwner = (identity: string): LockOwner | undefined => {
  try {
    const owner = JSON.parse(identity) as Partial<LockOwner>;
    if (
      owner.version !== 1 ||
      !Number.isSafeInteger(owner.pid) ||
      (owner.pid ?? 0) < 1 ||
      typeof owner.bootId !== "string" ||
      !bootIdPattern.test(owner.bootId) ||
      typeof owner.startTimeTicks !== "string" ||
      !positiveIntegerPattern.test(owner.startTimeTicks) ||
      typeof owner.token !== "string" ||
      owner.token.length === 0
    ) return undefined;
    return owner as LockOwner;
  } catch {
    return undefined;
  }
};

export const createLockOwnerIdentity = async (): Promise<string> => {
  localProcessBirth ??= captureProcessBirth(process.pid).then((identity) => {
    if (identity === undefined) throw new Error("Unable to capture lock owner identity");
    return identity;
  });
  return `${JSON.stringify({
    ...await localProcessBirth,
    token: randomUUID(),
    version: 1,
  } satisfies LockOwner)}\n`;
};

export const lockOwnerIsAlive = async (identity: string): Promise<boolean> => {
  const owner = parseOwner(identity);
  if (owner === undefined) return false;
  try {
    const current = await captureProcessBirth(owner.pid);
    return current !== undefined &&
      current.bootId === owner.bootId &&
      current.startTimeTicks === owner.startTimeTicks;
  } catch {
    return true;
  }
};

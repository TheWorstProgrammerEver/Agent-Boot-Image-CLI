import type { ChildProcess } from 'node:child_process';

const isMissingProcess = (error: unknown): boolean =>
  (error as NodeJS.ErrnoException).code === 'ESRCH';

export const signalProcessGroup = (
  child: ChildProcess,
  signal: NodeJS.Signals,
): boolean => {
  if (child.pid === undefined) return false;

  try {
    process.kill(-child.pid, signal);
    return true;
  } catch (error) {
    if (!isMissingProcess(error)) return false;
    return child.kill(signal);
  }
};

export const processGroupExists = (child: ChildProcess): boolean => {
  if (child.pid === undefined) return false;

  try {
    process.kill(-child.pid, 0);
    return true;
  } catch (error) {
    return !isMissingProcess(error);
  }
};

const delay = (milliseconds: number): Promise<void> =>
  new Promise(resolve => setTimeout(resolve, milliseconds));

const waitForExit = async (
  child: ChildProcess,
  waitMs: number,
  pollMs: number,
): Promise<boolean> => {
  const deadline = Date.now() + waitMs;
  while (processGroupExists(child)) {
    if (Date.now() >= deadline) return false;
    await delay(pollMs);
  }
  return true;
};

export const terminateProcessGroup = async (
  child: ChildProcess,
  signal: NodeJS.Signals,
  graceMs: number,
): Promise<void> => {
  if (!processGroupExists(child)) return;
  signalProcessGroup(child, signal);
  if (signal === 'SIGKILL' || await waitForExit(child, graceMs, 5)) return;
  signalProcessGroup(child, 'SIGKILL');
  await waitForExit(child, graceMs, 5);
};

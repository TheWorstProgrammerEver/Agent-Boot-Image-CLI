import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";
import { clearInterval, setInterval, setTimeout } from "node:timers";

const processDirectory = "/proc";

const processIdentity = record => `${record.pid}:${record.startTime}`;

const readProcessRecord = async entry => {
  try {
    const stat = await readFile(join(processDirectory, entry, "stat"), "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/u);
    if (fields.length < 20) return undefined;
    return {
      parentPid: Number(fields[1]),
      pid: Number(entry),
      processGroupId: Number(fields[2]),
      sessionId: Number(fields[3]),
      startTime: fields[19],
    };
  } catch {
    // A process may exit between directory enumeration and stat inspection.
    return undefined;
  }
};

export const processSnapshot = async () => {
  const entries = (await readdir(processDirectory))
    .filter(entry => /^\d+$/u.test(entry));
  const records = [];
  for (let index = 0; index < entries.length; index += 32) {
    records.push(...await Promise.all(
      entries.slice(index, index + 32).map(readProcessRecord),
    ));
  }
  return new Map(records.filter(Boolean).map(record => [record.pid, record]));
};

const isDescendant = (table, pid, rootPid) => {
  let current = pid;
  const visited = new Set();
  while (table.has(current) && !visited.has(current)) {
    visited.add(current);
    current = table.get(current).parentPid;
    if (current === rootPid) return true;
  }
  return false;
};

const trackedFromSnapshot = (table, rootPid) => [...table.values()].filter(record =>
  record.pid !== rootPid && (
    record.processGroupId === rootPid ||
    record.sessionId === rootPid ||
    isDescendant(table, record.pid, rootPid)
  ));

export const startDescendantTracker = (rootPid, intervalMilliseconds = 10) => {
  const tracked = new Map();
  let failure;
  let sampling;

  const sample = async () => {
    if (sampling !== undefined) return sampling;
    sampling = (async () => {
      const table = await processSnapshot();
      for (const record of trackedFromSnapshot(table, rootPid)) {
        tracked.set(processIdentity(record), record);
      }
    })().catch(error => { failure = error; }).finally(() => { sampling = undefined; });
    await sampling;
  };

  void sample();
  const timer = setInterval(() => { void sample(); }, intervalMilliseconds);
  timer.unref();

  return {
    async stop() {
      clearInterval(timer);
      await sample();
      await sample();
      if (failure !== undefined) throw failure;
      return [...tracked.values()];
    },
  };
};

export const liveTrackedProcesses = async tracked => {
  const table = await processSnapshot();
  return tracked.flatMap(record => {
    const current = table.get(record.pid);
    return current?.startTime === record.startTime ? [current] : [];
  });
};

const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

export const waitForTrackedProcessesToExit = async (
  tracked,
  timeoutMilliseconds = 250,
) => {
  const deadline = Date.now() + timeoutMilliseconds;
  let live = await liveTrackedProcesses(tracked);
  while (live.length > 0 && Date.now() < deadline) {
    await wait(10);
    live = await liveTrackedProcesses(tracked);
  }
  return live;
};

export const terminateTrackedProcesses = async tracked => {
  const sendSignal = async (record, signal) => {
    const current = await readProcessRecord(String(record.pid));
    if (current?.startTime !== record.startTime) return;
    try {
      process.kill(record.pid, signal);
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
  };
  for (const record of tracked) {
    await sendSignal(record, "SIGTERM");
  }
  let live = await waitForTrackedProcessesToExit(tracked);
  for (const record of live) {
    await sendSignal(record, "SIGKILL");
  }
  live = await waitForTrackedProcessesToExit(tracked);
  return live;
};

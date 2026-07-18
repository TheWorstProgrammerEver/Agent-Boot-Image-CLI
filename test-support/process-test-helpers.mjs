import { exec } from 'node:child_process';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';

export const executableNode = process.execPath;

export const shellBash = (command, options = {}) => new Promise((resolve, reject) => {
  exec(command, {
    encoding: 'utf8',
    maxBuffer: options.maxBufferBytes,
    timeout: options.timeoutMs,
  }, (error, stdout, stderr) => {
    const trimmedStdout = stdout.replace(/(?:\r?\n)+$/u, '');
    const trimmedStderr = stderr.replace(/(?:\r?\n)+$/u, '');
    if (error === null) {
      resolve(trimmedStdout);
      return;
    }

    reject(Object.assign(error, {
      exitCode: typeof error.code === 'number' ? error.code : null,
      reason: error.killed ? 'timeout' : error.signal === null ? 'exit' : 'signal',
      stderr: trimmedStderr,
      stdout: trimmedStdout,
    }));
  });
});

export const waitFor = async (predicate, timeoutMs = 2_000) => {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for test condition');
    await delay(5);
  }
};

export const processExists = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === 'ESRCH') return false;
    throw error;
  }
};

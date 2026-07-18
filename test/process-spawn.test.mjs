import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { spawn as nodeSpawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import { CommandStartError, NodeSpawnAdapter } from '@agent-boot/process';

import {
  executableNode,
  processExists,
  waitFor,
} from '../test-support/process-test-helpers.mjs';

const streamedCommand = (script, overrides = {}) => ({
  arguments: ['-e', script],
  executable: executableNode,
  lifetime: { policy: 'managed' },
  stdio: 'stream',
  ...overrides,
});

test('spawn preserves arguments and environment while streaming both outputs', async () => {
  const chunks = [];
  const arguments_ = ['space value', '$HOME', "single'quote", ''];
  const script = [
    'process.stdout.write(JSON.stringify({',
    'args: process.argv.slice(1),',
    'environment: process.env.PROCESS_TEST_VALUE',
    '}));',
    "process.stderr.write('stderr-data');",
  ].join('');
  const running = new NodeSpawnAdapter().spawn(streamedCommand(script, {
    arguments: ['-e', script, ...arguments_],
    environment: { PROCESS_TEST_VALUE: 'literal value' },
    onOutput: chunk => chunks.push(chunk),
  }));

  const result = await running.completion;
  const stdout = Buffer.concat(chunks.filter(chunk => chunk.stream === 'stdout').map(chunk => chunk.data));
  const stderr = Buffer.concat(chunks.filter(chunk => chunk.stream === 'stderr').map(chunk => chunk.data));

  assert.deepEqual(JSON.parse(stdout.toString()), {
    args: arguments_,
    environment: 'literal value',
  });
  assert.equal(stderr.toString(), 'stderr-data');
  assert.deepEqual(result, { exitCode: 0, reason: 'exit', signal: null });
});

test('spawn selects inherited TTY mode and explicit detached lifetime', async () => {
  let spawnOptions;
  let unrefCalled = false;
  const spawnProcess = (executable, arguments_, options) => {
    spawnOptions = options;
    const child = nodeSpawn(executable, arguments_, options);
    const unref = child.unref.bind(child);
    child.unref = () => {
      unrefCalled = true;
      return unref();
    };
    return child;
  };
  const running = new NodeSpawnAdapter({ spawnProcess }).spawn({
    arguments: ['-e', 'process.exit(0)'],
    executable: executableNode,
    lifetime: { policy: 'detached', unref: true },
    stdio: 'inherit',
  });

  assert.equal((await running.completion).exitCode, 0);
  assert.equal(spawnOptions.detached, true);
  assert.equal(spawnOptions.shell, false);
  assert.equal(spawnOptions.stdio, 'inherit');
  assert.equal(unrefCalled, true);
});

test('pre-aborted cancellation wins without starting a child', async () => {
  const controller = new globalThis.AbortController();
  controller.abort();
  let spawnCalls = 0;
  const adapter = new NodeSpawnAdapter({
    spawnProcess: () => {
      spawnCalls += 1;
      throw new Error('must not spawn');
    },
  });
  const running = adapter.spawn(streamedCommand('process.exit(0)', {
    cancellation: controller.signal,
  }));

  assert.deepEqual(await running.completion, {
    exitCode: null,
    reason: 'canceled',
    signal: null,
  });
  assert.equal(spawnCalls, 0);
});

test('cancellation closing the precheck-listener race still terminates the child', async () => {
  let checks = 0;
  const cancellation = {
    addEventListener: () => undefined,
    get aborted() {
      checks += 1;
      return checks > 1;
    },
    removeEventListener: () => undefined,
  };
  const running = new NodeSpawnAdapter().spawn(streamedCommand('setInterval(() => {}, 1000)', {
    cancellation,
  }));

  assert.equal((await running.completion).reason, 'canceled');
});

test('active cancellation wins its race with timeout', async () => {
  const running = new NodeSpawnAdapter().spawn(streamedCommand('setInterval(() => {}, 1000)', {
    timeoutMs: 1_000,
  }));
  running.cancel();

  const result = await running.completion;
  assert.equal(result.reason, 'canceled');
  assert.equal(result.signal, 'SIGTERM');
});

test('timeout terminates a managed child and maps the signal', async () => {
  const running = new NodeSpawnAdapter().spawn(streamedCommand('setInterval(() => {}, 1000)', {
    timeoutMs: 30,
  }));

  const result = await running.completion;
  assert.equal(result.reason, 'timeout');
  assert.equal(result.signal, 'SIGTERM');
});

test('signal exits map independently from cancellation', async () => {
  const running = new NodeSpawnAdapter().spawn(streamedCommand("process.kill(process.pid, 'SIGUSR2')"));
  const result = await running.completion;

  assert.equal(result.exitCode, null);
  assert.equal(result.reason, 'signal');
  assert.equal(result.signal, 'SIGUSR2');
});

test('non-zero exits retain their exit code without becoming a signal', async () => {
  const running = new NodeSpawnAdapter().spawn(streamedCommand('process.exit(7)'));
  assert.deepEqual(await running.completion, {
    exitCode: 7,
    reason: 'exit',
    signal: null,
  });
});

test('spawn failures expose a safe error code and redacted command', async () => {
  const secret = 'conspicuous-missing-command';
  const running = new NodeSpawnAdapter().spawn(streamedCommand('', {
    arguments: ['--token', secret],
    executable: `${secret}-executable`,
    sensitiveValues: [secret],
  }));

  await assert.rejects(running.completion, error => {
    assert.ok(error instanceof CommandStartError);
    assert.equal(error.code, 'ENOENT');
    assert.doesNotMatch(error.message, new RegExp(secret, 'u'));
    assert.match(error.message, /ENOENT/u);
    return true;
  });
});

test('configured parent signals forward to the managed process group', async () => {
  const signalSource = new EventEmitter();
  let output = '';
  const running = new NodeSpawnAdapter({ signalSource }).spawn(streamedCommand([
    "process.on('SIGUSR1', () => process.stdout.write('forwarded'));",
    "process.stdout.write('ready');",
    'setInterval(() => {}, 1000);',
  ].join(''), {
    forwardSignals: ['SIGUSR1'],
    onOutput: chunk => { output += Buffer.from(chunk.data).toString(); },
  }));

  await waitFor(() => output.includes('ready'));
  signalSource.emit('SIGUSR1');
  await waitFor(() => output.includes('forwarded'));
  running.cancel();
  await running.completion;

  assert.equal(signalSource.listenerCount('SIGUSR1'), 0);
});

test('managed cancellation removes a resistant descendant process', async () => {
  let output = '';
  const descendant = "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);";
  const parent = [
    "const { spawn } = require('node:child_process');",
    `const child = spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}], { stdio: 'ignore' });`,
    "process.stdout.write(String(child.pid) + '\\n');",
    "process.on('SIGTERM', () => {});",
    'setInterval(() => {}, 1000);',
  ].join('');
  const running = new NodeSpawnAdapter({ terminationGraceMs: 30 }).spawn(streamedCommand(parent, {
    onOutput: chunk => { output += Buffer.from(chunk.data).toString(); },
  }));

  await waitFor(() => /^\d+\n$/u.test(output));
  const descendantPid = Number.parseInt(output, 10);
  assert.equal(processExists(descendantPid), true);
  running.cancel();
  const result = await running.completion;

  assert.equal(result.reason, 'canceled');
  await waitFor(() => !processExists(descendantPid));
  assert.equal(processExists(descendantPid), false);
});

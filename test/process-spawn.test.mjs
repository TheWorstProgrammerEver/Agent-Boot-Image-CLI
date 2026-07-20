import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { spawn as nodeSpawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import process from 'node:process';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import { CommandStartError, NodeSpawnAdapter } from '@agent-boot/process';

import {
  executableNode,
  processExists,
  processIsRunning,
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

test('spawn writes deliberate stdin without exposing it in command diagnostics', async () => {
  const marker = 'provider-prompt-private-marker';
  const chunks = [];
  const running = new NodeSpawnAdapter().spawn(streamedCommand([
    "process.stdin.setEncoding('utf8');",
    "let input = '';",
    "process.stdin.on('data', chunk => { input += chunk; });",
    "process.stdin.on('end', () => process.stdout.write(String(input.length)));",
  ].join(''), {
    onOutput: chunk => chunks.push(chunk),
    stdin: marker,
  }));

  assert.equal((await running.completion).exitCode, 0);
  assert.equal(Buffer.concat(chunks.map(chunk => chunk.data)).toString(), String(marker.length));
});

test('spawn rejects deliberate stdin with inherited stdio before launch', () => {
  let spawnCalls = 0;
  const adapter = new NodeSpawnAdapter({
    spawnProcess: () => {
      spawnCalls += 1;
      throw new Error('must not spawn');
    },
  });

  assert.throws(() => adapter.spawn({
    executable: executableNode,
    lifetime: { policy: 'managed' },
    stdin: 'private',
    stdio: 'inherit',
  }), /deliberate stdin/u);
  assert.equal(spawnCalls, 0);
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

test('spawn duplicates an explicit terminal onto all three child descriptors', async () => {
  const child = new EventEmitter();
  let inspectedDescriptor;
  let spawnOptions;
  const running = new NodeSpawnAdapter({
    spawnProcess: (_executable, _arguments, options) => {
      spawnOptions = options;
      globalThis.queueMicrotask(() => {
        child.emit('exit', 0, null);
        child.emit('close', 0, null);
      });
      return child;
    },
    terminalInspector: descriptor => {
      inspectedDescriptor = descriptor;
      return true;
    },
  }).spawn({
    executable: executableNode,
    lifetime: { policy: 'detached', unref: false },
    stdio: { descriptor: 73, type: 'terminal' },
  });

  assert.equal(inspectedDescriptor, 73);
  assert.deepEqual(spawnOptions.stdio, [73, 73, 73]);
  assert.deepEqual(await running.completion, { exitCode: 0, reason: 'exit', signal: null });
});

test('spawn rejects a terminal descriptor that is not a TTY before launch', () => {
  let spawnCalls = 0;
  const adapter = new NodeSpawnAdapter({
    spawnProcess: () => {
      spawnCalls += 1;
      throw new Error('must not spawn');
    },
    terminalInspector: () => false,
  });

  assert.throws(() => adapter.spawn({
    executable: executableNode,
    lifetime: { policy: 'managed' },
    stdio: { descriptor: 0, type: 'terminal' },
  }), /must reference a TTY/u);
  assert.equal(spawnCalls, 0);
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

test('managed leader exit removes a resistant descendant holding streamed output open', async () => {
  let output = '';
  const descendant = [
    "const { writeSync } = require('node:fs');",
    "process.on('SIGTERM', () => { writeSync(1, 'descendant-terminated\\n'); });",
    "writeSync(1, 'pid:' + String(process.pid) + '\\n');",
    "writeSync(3, 'ready');",
    'setInterval(() => {}, 1000);',
  ].join('');
  const leader = [
    "const { spawn } = require('node:child_process');",
    `const child = spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}], { stdio: ['ignore', 1, 2, 'pipe'] });`,
    "child.stdio[3].once('data', () => {",
    'child.stdio[3].destroy();',
    'child.unref();',
    '});',
  ].join('');
  const running = new NodeSpawnAdapter({ terminationGraceMs: 30 }).spawn(streamedCommand(leader, {
    onOutput: chunk => { output += Buffer.from(chunk.data).toString(); },
  }));

  try {
    await waitFor(() => /^pid:\d+\n/u.test(output));
    const descendantPid = Number.parseInt(output.slice(4), 10);
    const result = await Promise.race([
      running.completion,
      delay(1_000, undefined, { ref: false }).then(() => {
        throw new Error('managed completion did not settle');
      }),
    ]);

    assert.deepEqual(result, { exitCode: 0, reason: 'exit', signal: null });
    assert.equal(output, `pid:${String(descendantPid)}\ndescendant-terminated\n`);
    await waitFor(() => !processIsRunning(descendantPid));
    assert.equal(processIsRunning(descendantPid), false);
  } finally {
    if (running.pid !== undefined) {
      try {
        process.kill(-running.pid, 'SIGKILL');
      } catch (error) {
        assert.equal(error.code, 'ESRCH');
      }
    }
  }
});

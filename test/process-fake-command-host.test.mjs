import assert from 'node:assert/strict';
import test from 'node:test';
import { TextDecoder, TextEncoder } from 'node:util';

import {
  FakeCommandHost,
  FakeCommandScriptError,
} from '@agent-boot/process';

test('fake command host records snapshots and scripts bounded results', async () => {
  const host = new FakeCommandHost()
    .scriptExecResult({ exitCode: 0, signal: null, stderr: '', stdout: 'first' })
    .scriptExecError(new Error('scripted failure'));
  const arguments_ = ['one'];
  const command = { arguments: arguments_, executable: 'tool' };

  assert.equal((await host.exec(command)).stdout, 'first');
  arguments_[0] = 'mutated';
  assert.deepEqual(host.execCalls[0].arguments, ['one']);
  await assert.rejects(host.exec(command), /scripted failure/u);
  await assert.rejects(host.exec(command), FakeCommandScriptError);
});

test('fake command host scripts streamed output and completion', async () => {
  const output = [];
  const host = new FakeCommandHost().scriptSpawnResult({
    output: [
      { data: new TextEncoder().encode('out'), stream: 'stdout' },
      { data: new TextEncoder().encode('err'), stream: 'stderr' },
    ],
    result: { exitCode: 7, reason: 'exit', signal: null },
  });
  const command = {
    arguments: ['argument'],
    executable: 'tool',
    lifetime: { policy: 'managed' },
    onOutput: chunk => output.push(`${chunk.stream}:${new TextDecoder().decode(chunk.data)}`),
    stdio: 'stream',
  };
  const running = host.spawn(command);

  assert.deepEqual(await running.completion, { exitCode: 7, reason: 'exit', signal: null });
  assert.deepEqual(output, ['stdout:out', 'stderr:err']);
  assert.equal(host.spawnCalls.length, 1);
  assert.notEqual(host.spawnCalls[0], command);
});

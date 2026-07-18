import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  BoundedExecError,
  TypescriptBashExecAdapter,
  formatCommand,
  representCommand,
} from '@agent-boot/process';

import { executableNode, shellBash } from '../test-support/process-test-helpers.mjs';

test('bounded exec preserves structured arguments, environment, and cwd', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'agent-boot-process-exec-'));
  try {
    const adapter = new TypescriptBashExecAdapter(shellBash);
    const arguments_ = ['space value', '$HOME', "single'quote", '', 'line\nbreak'];
    const script = [
      'process.stdout.write(JSON.stringify({',
      'args: process.argv.slice(1),',
      'cwd: process.cwd(),',
      'environment: process.env.PROCESS_TEST_VALUE',
      '}));',
    ].join('');
    const result = await adapter.exec({
      arguments: ['-e', script, ...arguments_],
      cwd,
      environment: { PROCESS_TEST_VALUE: "literal '$HOME' value" },
      executable: executableNode,
    });

    assert.deepEqual(JSON.parse(result.stdout), {
      args: arguments_,
      cwd,
      environment: "literal '$HOME' value",
    });
    assert.equal(result.exitCode, 0);
    assert.equal(result.stderr, '');
  } finally {
    await rm(cwd, { force: true, recursive: true });
  }
});

test('bounded exec passes only bounded ts-bash options', async () => {
  let call;
  const adapter = new TypescriptBashExecAdapter(async (command, options) => {
    call = { command, options };
    return 'captured';
  });

  const result = await adapter.exec({
    arguments: ['--version'],
    executable: 'tool',
    label: 'read tool version',
    maxOutputBytes: 2048,
    timeoutMs: 500,
  });

  assert.equal(result.stdout, 'captured');
  assert.deepEqual(call.options, {
    context: 'read tool version',
    maxBufferBytes: 2048,
    timeoutMs: 500,
  });
  assert.match(call.command, /^'tool' '--version'$/u);
});

test('bounded exec maps exit and signal details through redaction', async () => {
  const secret = 'conspicuous-test-sentinel';
  const adapter = new TypescriptBashExecAdapter(async () => {
    throw {
      exitCode: null,
      reason: 'signal',
      signal: 'SIGTERM',
      stderr: `failure ${secret}`,
      stdout: `partial ${secret}`,
    };
  });

  await assert.rejects(
    adapter.exec({
      arguments: ['--token', secret],
      environment: { PROCESS_TOKEN: secret },
      executable: 'tool',
      label: `use ${secret}`,
      sensitiveValues: [secret],
    }),
    error => {
      assert.ok(error instanceof BoundedExecError);
      assert.equal(error.reason, 'signal');
      assert.equal(error.signal, 'SIGTERM');
      assert.doesNotMatch(error.message, new RegExp(secret, 'u'));
      assert.doesNotMatch(error.command, new RegExp(secret, 'u'));
      assert.equal(error.stderr, 'failure [REDACTED]');
      assert.equal(error.stdout, 'partial [REDACTED]');
      return true;
    },
  );
});

test('ordinary command representations omit environment values and redact hooks', () => {
  const command = {
    arguments: ['--password=alpha', 'visible'],
    cwd: '/tmp/alpha',
    environment: { API_TOKEN: 'alpha' },
    executable: 'alpha-tool',
    label: 'alpha operation',
    sensitiveValues: ['alpha'],
  };

  assert.deepEqual(representCommand(command), {
    arguments: ['--password=[REDACTED]', 'visible'],
    cwd: '/tmp/[REDACTED]',
    environmentKeys: ['API_TOKEN'],
    executable: '[REDACTED]-tool',
    label: '[REDACTED] operation',
  });
  assert.doesNotMatch(formatCommand(command), /alpha/u);
});

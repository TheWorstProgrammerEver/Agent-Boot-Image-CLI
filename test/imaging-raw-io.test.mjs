import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { mkdtemp, readFile, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  ExactRawImageWriter,
  FullReadBackVerifier,
  ImageWriteError,
  RawFileImageSource,
} from "@agent-boot/cli/imaging";

const bytes = Uint8Array.from({ length: 16_385 }, (_, index) => index % 251);

const memorySource = chunks => ({
  open: () => ({
    cancel: () => undefined,
    chunks: (async function* () {
      for (const chunk of chunks) yield chunk;
    })(),
    completion: Promise.resolve(),
  }),
});

const assertImagingError = async (promise, code) => {
  await assert.rejects(promise, error => {
    assert.ok(error instanceof ImageWriteError);
    assert.equal(error.code, code);
    return true;
  });
};

test("regular-file raw write syncs exact bytes and full read-back verifies by default", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-boot-raw-io-"));
  const sourcePath = join(root, "source.raw");
  const targetPath = join(root, "target.raw");
  try {
    await writeFile(sourcePath, bytes);
    await writeFile(targetPath, new Uint8Array(bytes.byteLength));
    const source = new RawFileImageSource(sourcePath);
    const progress = [];
    const options = {
      cancellation: new globalThis.AbortController().signal,
      expectedByteLength: bytes.byteLength,
      onProgress: event => { progress.push(event); },
      source,
      targetPath,
    };

    assert.equal(await new ExactRawImageWriter().write(options), bytes.byteLength);
    assert.deepEqual(await readFile(targetPath), Buffer.from(bytes));
    assert.equal(await new FullReadBackVerifier().verify(options), bytes.byteLength);
    assert.deepEqual(progress.map(({ phase }) => phase), ["write", "verify"]);
    assert.ok(progress.every(({ completed, total, unit }) =>
      completed === bytes.byteLength && total === bytes.byteLength && unit === "bytes"));
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("raw writer detects short writes, short and oversized sources, and sync failure", async () => {
  const handle = overrides => ({
    close: async () => undefined,
    read: async () => ({ bytesRead: 0 }),
    sync: async () => undefined,
    write: async (_buffer, _offset, length) => ({ bytesWritten: length }),
    ...overrides,
  });
  const files = target => ({
    openRead: async () => target,
    openWrite: async () => target,
  });
  const options = source => ({
    cancellation: new globalThis.AbortController().signal,
    expectedByteLength: 4,
    source,
    targetPath: "/fixture/target.raw",
  });

  await assertImagingError(
    new ExactRawImageWriter(files(handle({
      write: async () => ({ bytesWritten: 0 }),
    }))).write(options(memorySource([Uint8Array.of(1, 2, 3, 4)]))),
    "short-write",
  );
  await assertImagingError(
    new ExactRawImageWriter(files(handle())).write(options(memorySource([Uint8Array.of(1, 2, 3)]))),
    "source-size-mismatch",
  );
  await assertImagingError(
    new ExactRawImageWriter(files(handle())).write(options(memorySource([Uint8Array.of(1, 2, 3, 4, 5)]))),
    "source-size-mismatch",
  );
  await assertImagingError(
    new ExactRawImageWriter(files(handle({
      sync: async () => { throw new Error("fixture sync failure"); },
    }))).write(options(memorySource([Uint8Array.of(1, 2, 3, 4)]))),
    "write-sync-failed",
  );
});

test("raw writer preserves operation and handle-close failures", async () => {
  const operationFailure = new ImageWriteError("short-write", "fixture write failure");
  const closeFailure = new Error("fixture write close failure");
  const target = {
    close: async () => { throw closeFailure; },
    read: async () => ({ bytesRead: 0 }),
    sync: async () => undefined,
    write: async () => { throw operationFailure; },
  };

  await assert.rejects(new ExactRawImageWriter({
    openRead: async () => target,
    openWrite: async () => target,
  }).write({
    cancellation: new globalThis.AbortController().signal,
    expectedByteLength: 4,
    source: memorySource([Uint8Array.of(1, 2, 3, 4)]),
    targetPath: "/fixture/target.raw",
  }), error => {
    assert.ok(error instanceof ImageWriteError);
    assert.equal(error.code, "cleanup-failed");
    assert.ok(error.cause instanceof AggregateError);
    assert.deepEqual(error.cause.errors, [operationFailure, closeFailure]);
    return true;
  });
});

test("full read-back comparison rejects short reads and mismatches", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-boot-read-back-"));
  const sourcePath = join(root, "source.raw");
  const targetPath = join(root, "target.raw");
  try {
    await writeFile(sourcePath, bytes);
    await writeFile(targetPath, bytes);
    const options = {
      cancellation: new globalThis.AbortController().signal,
      expectedByteLength: bytes.byteLength,
      source: new RawFileImageSource(sourcePath),
      targetPath,
    };

    const mismatched = Uint8Array.from(bytes);
    mismatched[8_000] ^= 0xff;
    await writeFile(targetPath, mismatched);
    await assertImagingError(new FullReadBackVerifier().verify(options), "read-back-mismatch");

    await writeFile(targetPath, bytes);
    await truncate(targetPath, bytes.byteLength - 1);
    await assertImagingError(new FullReadBackVerifier().verify(options), "short-read");
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("read-back verifier preserves operation and handle-close failures", async () => {
  const operationFailure = new ImageWriteError("short-read", "fixture read failure");
  const closeFailure = new Error("fixture read close failure");
  const target = {
    close: async () => { throw closeFailure; },
    read: async () => { throw operationFailure; },
    sync: async () => undefined,
    write: async (_buffer, _offset, length) => ({ bytesWritten: length }),
  };

  await assert.rejects(new FullReadBackVerifier({
    openRead: async () => target,
    openWrite: async () => target,
  }).verify({
    cancellation: new globalThis.AbortController().signal,
    expectedByteLength: 4,
    source: memorySource([Uint8Array.of(1, 2, 3, 4)]),
    targetPath: "/fixture/target.raw",
  }), error => {
    assert.ok(error instanceof ImageWriteError);
    assert.equal(error.code, "cleanup-failed");
    assert.ok(error.cause instanceof AggregateError);
    assert.deepEqual(error.cause.errors, [operationFailure, closeFailure]);
    return true;
  });
});

test("raw adapters await stream completion when cancellation cleanup throws", async t => {
  const cases = [
    {
      createAdapter: target => new ExactRawImageWriter({
        openRead: async () => target,
        openWrite: async () => target,
      }),
      invoke: (adapter, options) => adapter.write(options),
      name: "writer",
      operationFailure: new ImageWriteError("short-write", "fixture write failure"),
    },
    {
      createAdapter: target => new FullReadBackVerifier({
        openRead: async () => target,
        openWrite: async () => target,
      }),
      invoke: (adapter, options) => adapter.verify(options),
      name: "verifier",
      operationFailure: new ImageWriteError("short-read", "fixture read failure"),
    },
  ];

  for (const fixture of cases) {
    await t.test(fixture.name, async () => {
      const cancelFailure = new Error(`fixture ${fixture.name} cancel failure`);
      let completionAwaited = false;
      const source = {
        open: () => ({
          cancel: () => { throw cancelFailure; },
          chunks: (async function* () { yield Uint8Array.of(1, 2, 3, 4); })(),
          completion: {
            then: resolve => {
              completionAwaited = true;
              resolve();
            },
          },
        }),
      };
      const target = {
        close: async () => undefined,
        read: async () => { throw fixture.operationFailure; },
        sync: async () => undefined,
        write: async () => { throw fixture.operationFailure; },
      };

      await assert.rejects(fixture.invoke(fixture.createAdapter(target), {
        cancellation: new globalThis.AbortController().signal,
        expectedByteLength: 4,
        source,
        targetPath: "/fixture/target.raw",
      }), error => {
        assert.ok(error instanceof ImageWriteError);
        assert.equal(error.code, "cleanup-failed");
        assert.ok(error.cause instanceof AggregateError);
        assert.deepEqual(error.cause.errors, [fixture.operationFailure, cancelFailure]);
        return true;
      });
      assert.equal(completionAwaited, true);
    });
  }
});

test("cancellation stops and awaits an active image stream", async () => {
  const cancellation = new globalThis.AbortController();
  let canceled = 0;
  let completionSettled = false;
  let rejectCompletion;
  const completion = new Promise((_, reject) => { rejectCompletion = reject; })
    .finally(() => { completionSettled = true; });
  const source = {
    open: () => ({
      cancel: () => {
        canceled += 1;
        rejectCompletion(new Error("fixture producer stopped"));
      },
      chunks: (async function* () {
        yield Uint8Array.of(1, 2);
        cancellation.abort();
        yield Uint8Array.of(3, 4);
      })(),
      completion,
    }),
  };
  const target = {
    close: async () => undefined,
    read: async () => ({ bytesRead: 0 }),
    sync: async () => undefined,
    write: async (_buffer, _offset, length) => ({ bytesWritten: length }),
  };

  await assertImagingError(new ExactRawImageWriter({
    openRead: async () => target,
    openWrite: async () => target,
  }).write({
    cancellation: cancellation.signal,
    expectedByteLength: 4,
    source,
    targetPath: "/fixture/target.raw",
  }), "canceled");
  assert.equal(canceled, 1);
  assert.equal(completionSettled, true);
});

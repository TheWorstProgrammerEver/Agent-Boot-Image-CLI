import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { access, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import { ArtifactCache } from "../packages/cli/dist/images/artifact-cache.js";
import { ArtifactAcquisitionError } from "@agent-boot/cli/images";

import {
  ScriptedArtifactTransport,
  chunks,
  createArtifactFixture,
  response,
} from "../test-support/artifact-cache-helpers.mjs";

const isMissing = async path => {
  try {
    await access(path);
    return false;
  } catch {
    return true;
  }
};

const cacheFor = (fixture, transport) => new ArtifactCache({
  cacheDirectory: fixture.cacheDirectory,
  inspector: fixture.inspector,
  lockPollMs: 5,
  lockTimeoutMs: 2_000,
  transport,
});

const successfulResponse = payload => response({
  body: chunks(payload),
  headers: { "content-length": payload.byteLength },
});

test("a verified download is atomically promoted into its content-addressed cache", async () => {
  const fixture = await createArtifactFixture();
  try {
    const transport = new ScriptedArtifactTransport(successfulResponse(fixture.payload));
    const result = await cacheFor(fixture, transport).acquire(fixture.lock);

    assert.equal(result.path, fixture.paths.artifact);
    assert.equal(result.sha256, fixture.lock.artifact.sha256);
    assert.equal(result.source, "download");
    assert.equal(result.compressionFormat, "xz");
    assert.equal(result.imageFormat, "raw");
    assert.equal(result.compressedByteLength, fixture.payload.byteLength);
    assert.equal(result.imageByteLength, 4_096);
    assert.deepEqual(await readFile(result.path), fixture.payload);
    assert.equal(await isMissing(fixture.paths.partial), true);
    assert.equal(await isMissing(fixture.paths.lock), true);
    assert.deepEqual(transport.calls, [{ offset: 0, url: fixture.lock.artifact.url }]);
  } finally {
    await fixture.cleanup();
  }
});

test("an interrupted download remains partial and resumes from the exact byte offset", async () => {
  const fixture = await createArtifactFixture();
  try {
    const split = 9;
    const interruptedBody = {
      async *[Symbol.asyncIterator]() {
        yield fixture.payload.subarray(0, split);
        throw new Error("connection reset with diagnostic-secret");
      },
    };
    const transport = new ScriptedArtifactTransport(
      response({
        body: interruptedBody,
        headers: { "content-length": fixture.payload.byteLength },
      }),
      () => response({
        body: chunks(fixture.payload.subarray(split)),
        headers: {
          "content-length": fixture.payload.byteLength - split,
          "content-range": `bytes ${String(split)}-${String(fixture.payload.byteLength - 1)}/${String(fixture.payload.byteLength)}`,
        },
        status: 206,
      }),
    );
    const cache = cacheFor(fixture, transport);

    await assert.rejects(
      cache.acquire(fixture.lock),
      error =>
        error instanceof ArtifactAcquisitionError &&
        error.code === "download-interrupted" &&
        !error.message.includes("diagnostic-secret"),
    );
    assert.deepEqual(await readFile(fixture.paths.partial), fixture.payload.subarray(0, split));
    assert.equal(await isMissing(fixture.paths.artifact), true);
    assert.equal(await isMissing(fixture.paths.lock), true);

    const result = await cache.acquire(fixture.lock);
    assert.equal(result.source, "download");
    assert.deepEqual(await readFile(result.path), fixture.payload);
    assert.deepEqual(transport.calls.map(({ offset }) => offset), [0, split]);
  } finally {
    await fixture.cleanup();
  }
});

test("a server that ignores Range safely restarts the partial download", async () => {
  const fixture = await createArtifactFixture();
  try {
    const partial = fixture.payload.subarray(0, 7);
    await mkdir(fixture.paths.partialDirectory, { recursive: true });
    await writeFile(fixture.paths.partial, partial);
    const transport = new ScriptedArtifactTransport(successfulResponse(fixture.payload));

    const result = await cacheFor(fixture, transport).acquire(fixture.lock);
    assert.deepEqual(await readFile(result.path), fixture.payload);
    assert.deepEqual(transport.calls.map(({ offset }) => offset), [partial.byteLength]);
  } finally {
    await fixture.cleanup();
  }
});

test("invalid resume ranges and redirects fail without promoting bytes", async () => {
  for (const scenario of ["range", "redirect"]) {
    const fixture = await createArtifactFixture();
    try {
      if (scenario === "range") {
        await mkdir(fixture.paths.partialDirectory, { recursive: true });
        await writeFile(fixture.paths.partial, fixture.payload.subarray(0, 4));
      }
      const transport = new ScriptedArtifactTransport(
        scenario === "redirect"
          ? response({ status: 302, headers: { location: "https://diagnostic-secret.invalid/" } })
          : response({
              body: chunks(fixture.payload.subarray(4)),
              status: 206,
              headers: { "content-range": `bytes 0-1/${String(fixture.payload.byteLength)}` },
            }),
      );
      const expectedCode = scenario === "redirect" ? "redirect-rejected" : "invalid-range";
      await assert.rejects(
        cacheFor(fixture, transport).acquire(fixture.lock),
        error =>
          error instanceof ArtifactAcquisitionError &&
          error.code === expectedCode &&
          !error.message.includes("diagnostic-secret"),
      );
      assert.equal(await isMissing(fixture.paths.artifact), true);
      assert.equal(await isMissing(fixture.paths.lock), true);
    } finally {
      await fixture.cleanup();
    }
  }
});

test("checksum mismatch removes unverified partial bytes", async () => {
  const fixture = await createArtifactFixture();
  try {
    const wrong = Buffer.alloc(fixture.payload.byteLength, 0x78);
    const transport = new ScriptedArtifactTransport(successfulResponse(wrong));
    await assert.rejects(
      cacheFor(fixture, transport).acquire(fixture.lock),
      error => error instanceof ArtifactAcquisitionError && error.code === "checksum-mismatch",
    );
    assert.equal(await isMissing(fixture.paths.artifact), true);
    assert.equal(await isMissing(fixture.paths.partial), true);
    assert.equal(await isMissing(fixture.paths.lock), true);
  } finally {
    await fixture.cleanup();
  }
});

test("oversized and range-inconsistent bodies are discarded without promotion", async () => {
  for (const scenario of ["oversized", "range-body"]) {
    const fixture = await createArtifactFixture();
    try {
      let transport;
      if (scenario === "oversized") {
        transport = new ScriptedArtifactTransport(response({
          body: chunks(fixture.payload, Buffer.from("extra")),
        }));
      } else {
        const split = 5;
        await mkdir(fixture.paths.partialDirectory, { recursive: true });
        await writeFile(fixture.paths.partial, fixture.payload.subarray(0, split));
        transport = new ScriptedArtifactTransport(response({
          body: chunks(fixture.payload.subarray(split)),
          headers: {
            "content-range": `bytes ${String(split)}-${String(split + 1)}/${String(fixture.payload.byteLength)}`,
          },
          status: 206,
        }));
      }

      await assert.rejects(
        cacheFor(fixture, transport).acquire(fixture.lock),
        error => error instanceof ArtifactAcquisitionError && error.code === "download-size",
      );
      assert.equal(await isMissing(fixture.paths.artifact), true);
      assert.equal(await isMissing(fixture.paths.partial), true);
      assert.equal(await isMissing(fixture.paths.lock), true);
    } finally {
      await fixture.cleanup();
    }
  }
});

test("a corrupt cache entry is quarantined and replaced with verified bytes", async () => {
  const fixture = await createArtifactFixture();
  try {
    const corrupt = Buffer.alloc(fixture.payload.byteLength, 0x63);
    await mkdir(fixture.paths.artifactDirectory, { recursive: true });
    await writeFile(fixture.paths.artifact, corrupt);
    const transport = new ScriptedArtifactTransport(successfulResponse(fixture.payload));

    const result = await cacheFor(fixture, transport).acquire(fixture.lock);
    const quarantined = await readdir(fixture.paths.quarantineDirectory);
    assert.equal(quarantined.length, 1);
    assert.deepEqual(
      await readFile(`${fixture.paths.quarantineDirectory}/${quarantined[0]}`),
      corrupt,
    );
    assert.deepEqual(await readFile(result.path), fixture.payload);
  } finally {
    await fixture.cleanup();
  }
});

test("concurrent acquisition uses one download and never exposes a partial final path", async () => {
  const fixture = await createArtifactFixture();
  try {
    let releaseBody;
    let bodyStarted;
    const started = new Promise(resolve => { bodyStarted = resolve; });
    const released = new Promise(resolve => { releaseBody = resolve; });
    const blockedBody = {
      async *[Symbol.asyncIterator]() {
        yield fixture.payload.subarray(0, 5);
        bodyStarted();
        await released;
        yield fixture.payload.subarray(5);
      },
    };
    const transport = new ScriptedArtifactTransport(response({
      body: blockedBody,
      headers: { "content-length": fixture.payload.byteLength },
    }));
    const cache = cacheFor(fixture, transport);

    const first = cache.acquire(fixture.lock);
    await started;
    const second = cache.acquire(fixture.lock);
    await delay(25);
    assert.equal(transport.calls.length, 1);
    assert.equal(await isMissing(fixture.paths.artifact), true);
    releaseBody();

    const [downloaded, cached] = await Promise.all([first, second]);
    assert.deepEqual([downloaded.source, cached.source], ["download", "cache"]);
    assert.equal(transport.calls.length, 1);
    assert.equal(fixture.inspectionCalls.length, 2);
    assert.equal(await isMissing(fixture.paths.lock), true);
  } finally {
    await fixture.cleanup();
  }
});

test("a verified cache hit works offline and does not use unverified bytes", async () => {
  const fixture = await createArtifactFixture();
  try {
    const transport = new ScriptedArtifactTransport(successfulResponse(fixture.payload));
    const cache = cacheFor(fixture, transport);
    await cache.acquire(fixture.lock);
    const cached = await cache.acquire(fixture.lock);

    assert.equal(cached.source, "cache");
    assert.equal(transport.calls.length, 1);
    assert.deepEqual(await readFile(cached.path), fixture.payload);
  } finally {
    await fixture.cleanup();
  }
});

test("cancellation aborts a pending request and releases its cache lock", async () => {
  const fixture = await createArtifactFixture();
  const cancellation = new globalThis.AbortController();
  let markRequested;
  const requested = new Promise(resolve => { markRequested = resolve; });
  try {
    const transport = new ScriptedArtifactTransport(request => {
      markRequested();
      return new Promise((_resolve, reject) => {
        request.cancellation.addEventListener("abort", () => {
          reject(new Error("fixture request aborted"));
        }, { once: true });
      });
    });
    const acquisition = cacheFor(fixture, transport).acquire(
      fixture.lock,
      cancellation.signal,
    );
    await requested;
    cancellation.abort();

    await assert.rejects(
      acquisition,
      error => error instanceof ArtifactAcquisitionError && error.code === "canceled",
    );
    assert.equal(await isMissing(fixture.paths.lock), true);
    assert.equal(await isMissing(fixture.paths.artifact), true);
  } finally {
    await fixture.cleanup();
  }
});

test("cancellation short-circuits a cache-lock wait without disturbing the owner", async () => {
  const fixture = await createArtifactFixture();
  let releaseBody;
  let markBodyStarted;
  const bodyStarted = new Promise(resolve => { markBodyStarted = resolve; });
  const bodyReleased = new Promise(resolve => { releaseBody = resolve; });
  try {
    const transport = new ScriptedArtifactTransport(response({
      body: {
        async *[Symbol.asyncIterator]() {
          markBodyStarted();
          await bodyReleased;
          yield fixture.payload;
        },
      },
      headers: { "content-length": fixture.payload.byteLength },
    }));
    const cache = cacheFor(fixture, transport);
    const owner = cache.acquire(fixture.lock);
    await bodyStarted;

    const cancellation = new globalThis.AbortController();
    const waiter = cache.acquire(fixture.lock, cancellation.signal);
    await delay(15);
    cancellation.abort();
    await assert.rejects(
      waiter,
      error => error instanceof ArtifactAcquisitionError && error.code === "canceled",
    );
    assert.equal(await isMissing(fixture.paths.lock), false);

    releaseBody();
    await owner;
    assert.equal(await isMissing(fixture.paths.lock), true);
    assert.equal(await isMissing(fixture.paths.artifact), false);
  } finally {
    releaseBody?.();
    await fixture.cleanup();
  }
});

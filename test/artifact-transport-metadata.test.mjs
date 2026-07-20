import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createServer } from "node:http";
import test from "node:test";

import {
  ArtifactAcquisitionError,
  NativeArtifactTransport,
  XzMetadataInspector,
} from "@agent-boot/cli/images";
import { FakeCommandHost } from "@agent-boot/process";

const listen = server => new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => resolve());
});

const close = server => new Promise((resolve, reject) => {
  server.close(error => error === undefined ? resolve() : reject(error));
});

const collect = async body => {
  const values = [];
  for await (const chunk of body) values.push(chunk);
  return Buffer.concat(values);
};

test("native transport succeeds against local HTTP and never follows redirects", async () => {
  const payload = Buffer.from("local transport fixture", "utf8");
  let payloadRequests = 0;
  const server = createServer((request, response) => {
    if (request.url === "/redirect") {
      response.writeHead(302, { location: "/payload" });
      response.end();
      return;
    }
    payloadRequests += 1;
    response.writeHead(200, { "content-length": payload.byteLength });
    response.end(payload);
  });
  await listen(server);
  try {
    const address = server.address();
    assert.equal(typeof address, "object");
    const origin = `http://127.0.0.1:${String(address.port)}`;
    const transport = new NativeArtifactTransport();

    const redirect = await transport.request({ offset: 0, url: `${origin}/redirect` });
    assert.equal(redirect.status, 302);
    assert.equal(payloadRequests, 0);

    const success = await transport.request({ offset: 0, url: `${origin}/payload` });
    assert.equal(success.status, 200);
    assert.ok(success.body);
    assert.deepEqual(await collect(success.body), payload);
    assert.equal(payloadRequests, 1);
  } finally {
    await close(server);
  }
});

test("native transport aborts a pending HTTP request", async () => {
  let markStarted;
  const started = new Promise(resolve => { markStarted = resolve; });
  const server = createServer(() => { markStarted(); });
  await listen(server);
  try {
    const address = server.address();
    assert.equal(typeof address, "object");
    const cancellation = new globalThis.AbortController();
    const pending = new NativeArtifactTransport().request({
      cancellation: cancellation.signal,
      offset: 0,
      url: `http://127.0.0.1:${String(address.port)}/pending`,
    });
    await started;
    cancellation.abort();
    await assert.rejects(pending, error => error.name === "AbortError");
  } finally {
    server.closeAllConnections();
    await close(server);
  }
});

test("XZ metadata exposes verified compressed and raw image sizes", async () => {
  const commands = new FakeCommandHost().scriptSpawnResult({
    output: [{
      data: Buffer.from("name\t/path/fixture.img.xz\nfile\t1\t2\t31\t4096\t0.008\tCRC64\t0\n"),
      stream: "stdout",
    }],
    result: { exitCode: 0, reason: "exit", signal: null },
  });
  const inspector = new XzMetadataInspector(commands);
  const cancellation = new globalThis.AbortController();

  assert.deepEqual(await inspector.inspect(
    "/cache/definition-secret.img.xz",
    31,
    cancellation.signal,
  ), {
    compressedByteLength: 31,
    compressionFormat: "xz",
    imageByteLength: 4_096,
    imageFormat: "raw",
  });
  assert.deepEqual(commands.spawnCalls[0].arguments, [
    "--robot", "--list", "--", "/cache/definition-secret.img.xz",
  ]);
  assert.equal(commands.spawnCalls[0].cancellation, cancellation.signal);
  assert.deepEqual(commands.spawnCalls[0].sensitiveValues, ["/cache/definition-secret.img.xz"]);
});

test("XZ command failures are reduced to bounded non-secret diagnostics", async () => {
  const commands = new FakeCommandHost().scriptSpawnError(new Error("definition-secret"));
  const inspector = new XzMetadataInspector(commands);
  await assert.rejects(
    inspector.inspect("/cache/definition-secret.img.xz", 31),
    error =>
      error instanceof ArtifactAcquisitionError &&
      error.code === "metadata-inspection" &&
      !error.message.includes("definition-secret"),
  );
});

test("XZ metadata inspection cancels its managed command", async () => {
  const cancellation = new globalThis.AbortController();
  let command;
  const inspector = new XzMetadataInspector({
    spawn(input) {
      command = input;
      return {
        cancel: () => undefined,
        completion: new Promise(resolve => {
          input.cancellation.addEventListener("abort", () => {
            resolve({ exitCode: null, reason: "canceled", signal: null });
          }, { once: true });
        }),
        pid: undefined,
        sendSignal: () => false,
      };
    },
  });

  const pending = inspector.inspect("/cache/definition-secret.img.xz", 31, cancellation.signal);
  cancellation.abort();
  await assert.rejects(
    pending,
    error => error instanceof ArtifactAcquisitionError && error.code === "canceled",
  );
  assert.equal(command.cancellation, cancellation.signal);
});

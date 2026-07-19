import { open, rm } from "node:fs/promises";

import { ArtifactAcquisitionError } from "./errors.js";
import type { ArtifactResponse, ArtifactTransport } from "./model.js";

interface DownloadOptions {
  readonly expectedByteLength: number;
  readonly offset: number;
  readonly path: string;
  readonly transport: ArtifactTransport;
  readonly url: string;
}

const rangeByteLength = (
  response: ArtifactResponse,
  offset: number,
  expectedBytes: number,
): number => {
  const match = /^bytes (\d+)-(\d+)\/(\d+)$/u.exec(response.header("content-range") ?? "");
  const start = Number(match?.[1]);
  const end = Number(match?.[2]);
  const total = Number(match?.[3]);
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    !Number.isSafeInteger(total) ||
    start !== offset ||
    end < start ||
    end >= total ||
    total !== expectedBytes
  ) {
    throw new ArtifactAcquisitionError("invalid-range");
  }
  return end - start + 1;
};

const validateLengthHeader = (response: ArtifactResponse, expected: number): void => {
  const header = response.header("content-length");
  if (header !== undefined && (!/^\d+$/u.test(header) || Number(header) !== expected)) {
    throw new ArtifactAcquisitionError("download-size");
  }
};

const writeAll = async (
  handle: Awaited<ReturnType<typeof open>>,
  chunk: Uint8Array,
): Promise<void> => {
  let offset = 0;
  while (offset < chunk.byteLength) {
    const { bytesWritten } = await handle.write(
      chunk,
      offset,
      chunk.byteLength - offset,
      null,
    );
    if (bytesWritten < 1) throw new ArtifactAcquisitionError("download-interrupted");
    offset += bytesWritten;
  }
};

const responseFor = async (options: DownloadOptions): Promise<ArtifactResponse> => {
  try {
    return await options.transport.request({ offset: options.offset, url: options.url });
  } catch {
    throw new ArtifactAcquisitionError("download-interrupted");
  }
};

export const downloadArtifact = async (options: DownloadOptions): Promise<void> => {
  const response = await responseFor(options);
  if (response.status >= 300 && response.status < 400) {
    throw new ArtifactAcquisitionError("redirect-rejected");
  }

  let append = options.offset > 0;
  let expectedResponseBytes = options.expectedByteLength;
  if (options.offset > 0 && response.status === 206) {
    expectedResponseBytes = rangeByteLength(response, options.offset, options.expectedByteLength);
  } else if (response.status === 200) {
    append = false;
  } else {
    throw new ArtifactAcquisitionError("http-response");
  }
  validateLengthHeader(response, expectedResponseBytes);
  if (response.body === undefined) throw new ArtifactAcquisitionError("download-interrupted");

  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(options.path, append ? "a" : "w", 0o600);
  } catch {
    throw new ArtifactAcquisitionError("cache-access");
  }

  let failure: ArtifactAcquisitionError | undefined;
  let received = 0;
  const startingBytes = append ? options.offset : 0;
  try {
    try {
      for await (const chunk of response.body) {
        if (!(chunk instanceof Uint8Array)) {
          throw new ArtifactAcquisitionError("download-interrupted");
        }
        received += chunk.byteLength;
        if (
          received > expectedResponseBytes ||
          startingBytes + received > options.expectedByteLength
        ) {
          throw new ArtifactAcquisitionError("download-size");
        }
        await writeAll(handle, chunk);
      }
      await handle.sync();
    } catch (error) {
      await handle.sync().catch(() => undefined);
      failure = error instanceof ArtifactAcquisitionError
        ? error
        : new ArtifactAcquisitionError("download-interrupted");
    }
  } finally {
    await handle.close();
  }

  if (failure !== undefined) {
    if (failure.code === "download-size") await rm(options.path, { force: true });
    throw failure;
  }
  if (received !== expectedResponseBytes || startingBytes + received !== options.expectedByteLength) {
    throw new ArtifactAcquisitionError("download-interrupted");
  }
};

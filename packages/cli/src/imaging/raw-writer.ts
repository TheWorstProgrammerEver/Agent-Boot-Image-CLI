import { ImageWriteError } from "./errors.js";
import type { RawImageWriter, RawImageWriteOptions } from "./model.js";
import { NodeRawTargetFileHost, type RandomAccessFile, type RawTargetFileHost } from "./raw-file.js";
import { throwIfCanceled, validateByteLength, withImageStream } from "./stream.js";

const writeChunk = async (
  target: RandomAccessFile,
  chunk: Uint8Array,
  position: number,
  cancellation: AbortSignal,
): Promise<number> => {
  let offset = 0;
  while (offset < chunk.byteLength) {
    throwIfCanceled(cancellation);
    const { bytesWritten } = await target.write(
      chunk,
      offset,
      chunk.byteLength - offset,
      position + offset,
    );
    if (bytesWritten <= 0) {
      throw new ImageWriteError("short-write", "Target stopped accepting image bytes.");
    }
    offset += bytesWritten;
  }
  return offset;
};

export class ExactRawImageWriter implements RawImageWriter {
  readonly #files: RawTargetFileHost;

  constructor(files: RawTargetFileHost = new NodeRawTargetFileHost()) {
    this.#files = files;
  }

  async write(options: RawImageWriteOptions): Promise<number> {
    validateByteLength(options.expectedByteLength);
    throwIfCanceled(options.cancellation);

    let target: RandomAccessFile;
    try {
      target = await this.#files.openWrite(options.targetPath);
    } catch (error) {
      throw new ImageWriteError("target-access", "Target could not be opened for writing.", {
        cause: error,
      });
    }

    let operationError: unknown;
    try {
      const written = await withImageStream(
        options.source,
        options.cancellation,
        async chunks => {
          let position = 0;
          for await (const chunk of chunks) {
            throwIfCanceled(options.cancellation);
            if (chunk.byteLength === 0) continue;
            if (position + chunk.byteLength > options.expectedByteLength) {
              throw new ImageWriteError(
                "source-size-mismatch",
                "Image source exceeded its verified byte length.",
              );
            }
            position += await writeChunk(target, chunk, position, options.cancellation);
            options.onProgress?.({
              completed: position,
              phase: "write",
              total: options.expectedByteLength,
              unit: "bytes",
            });
          }
          if (position !== options.expectedByteLength) {
            throw new ImageWriteError(
              "source-size-mismatch",
              "Image source ended before its verified byte length.",
            );
          }
          return position;
        },
      );

      try {
        await target.sync();
      } catch (error) {
        throw new ImageWriteError("write-sync-failed", "Target image bytes could not be synced.", {
          cause: error,
        });
      }
      return written;
    } catch (error) {
      operationError = error;
      throw error;
    } finally {
      try {
        await target.close();
      } catch (error) {
        if (operationError === undefined) {
          throw new ImageWriteError("target-access", "Target write handle could not be closed.", {
            cause: error,
          });
        }
      }
    }
  }
}

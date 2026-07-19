import { ImageWriteError } from "./errors.js";
import type { ReadBackVerifier, ReadBackVerifyOptions } from "./model.js";
import { NodeRawTargetFileHost, type RandomAccessFile, type RawTargetFileHost } from "./raw-file.js";
import { throwIfCanceled, validateByteLength, withImageStream } from "./stream.js";

const readExact = async (
  target: RandomAccessFile,
  buffer: Uint8Array,
  position: number,
  cancellation: AbortSignal,
): Promise<void> => {
  let offset = 0;
  while (offset < buffer.byteLength) {
    throwIfCanceled(cancellation);
    const { bytesRead } = await target.read(
      buffer,
      offset,
      buffer.byteLength - offset,
      position + offset,
    );
    if (bytesRead <= 0) {
      throw new ImageWriteError("short-read", "Target ended before all image bytes were read back.");
    }
    offset += bytesRead;
  }
};

const equalBytes = (expected: Uint8Array, actual: Uint8Array): boolean => {
  for (let index = 0; index < expected.byteLength; index += 1) {
    if (expected[index] !== actual[index]) return false;
  }
  return true;
};

export class FullReadBackVerifier implements ReadBackVerifier {
  readonly #files: RawTargetFileHost;

  constructor(files: RawTargetFileHost = new NodeRawTargetFileHost()) {
    this.#files = files;
  }

  async verify(options: ReadBackVerifyOptions): Promise<number> {
    validateByteLength(options.expectedByteLength);
    throwIfCanceled(options.cancellation);

    let target: RandomAccessFile;
    try {
      target = await this.#files.openRead(options.targetPath);
    } catch (error) {
      throw new ImageWriteError("target-access", "Target could not be opened for read-back.", {
        cause: error,
      });
    }

    let operationError: unknown;
    try {
      return await withImageStream(
        options.source,
        options.cancellation,
        async chunks => {
          let position = 0;
          for await (const expected of chunks) {
            throwIfCanceled(options.cancellation);
            if (expected.byteLength === 0) continue;
            if (position + expected.byteLength > options.expectedByteLength) {
              throw new ImageWriteError(
                "source-size-mismatch",
                "Verification source exceeded its verified byte length.",
              );
            }
            const actual = new Uint8Array(expected.byteLength);
            await readExact(target, actual, position, options.cancellation);
            if (!equalBytes(expected, actual)) {
              throw new ImageWriteError(
                "read-back-mismatch",
                "Target read-back did not match the verified image bytes.",
              );
            }
            position += expected.byteLength;
            options.onProgress?.({
              completed: position,
              phase: "verify",
              total: options.expectedByteLength,
              unit: "bytes",
            });
          }
          if (position !== options.expectedByteLength) {
            throw new ImageWriteError(
              "source-size-mismatch",
              "Verification source ended before its verified byte length.",
            );
          }
          return position;
        },
      );
    } catch (error) {
      operationError = error;
      throw error;
    } finally {
      try {
        await target.close();
      } catch (error) {
        if (operationError === undefined) {
          throw new ImageWriteError("target-access", "Target read handle could not be closed.", {
            cause: error,
          });
        }
      }
    }
  }
}

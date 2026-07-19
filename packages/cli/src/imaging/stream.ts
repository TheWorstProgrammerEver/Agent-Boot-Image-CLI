import { ImageWriteError } from "./errors.js";
import type { ImageByteStream, RepeatableImageSource } from "./model.js";

export const validateByteLength = (value: number): void => {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new ImageWriteError(
      "invalid-byte-count",
      "Expected image byte length must be a positive safe integer.",
    );
  }
};

export const throwIfCanceled = (cancellation: AbortSignal): void => {
  if (cancellation.aborted) {
    throw new ImageWriteError("canceled", "Image write transaction was canceled.");
  }
};

const asSourceFailure = (error: unknown, cancellation: AbortSignal): Error => {
  if (cancellation.aborted) {
    return new ImageWriteError("canceled", "Image write transaction was canceled.", {
      cause: error,
    });
  }
  if (error instanceof ImageWriteError) return error;
  return new ImageWriteError("source-failed", "Image source did not complete successfully.", {
    cause: error,
  });
};

export const withImageStream = async <T>(
  source: RepeatableImageSource,
  cancellation: AbortSignal,
  consume: (chunks: AsyncIterable<Uint8Array>) => Promise<T>,
): Promise<T> => {
  throwIfCanceled(cancellation);
  let stream: ImageByteStream;
  try {
    stream = source.open(cancellation);
  } catch (error) {
    throw asSourceFailure(error, cancellation);
  }

  let completed = false;
  try {
    const result = await consume(stream.chunks);
    await stream.completion;
    completed = true;
    throwIfCanceled(cancellation);
    return result;
  } catch (error) {
    throw asSourceFailure(error, cancellation);
  } finally {
    if (!completed) stream.cancel();
    try {
      await stream.completion;
    } catch {
      // The operation error remains primary; completion is awaited to prevent orphan producers.
    }
  }
};

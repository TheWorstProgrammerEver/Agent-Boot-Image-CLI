import { createReadStream } from "node:fs";
import { open } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { finished } from "node:stream/promises";

import type { ImageByteStream, RepeatableImageSource } from "./model.js";

export interface RandomAccessFile {
  close(): Promise<void>;
  read(
    buffer: Uint8Array,
    offset: number,
    length: number,
    position: number,
  ): Promise<{ readonly bytesRead: number }>;
  sync(): Promise<void>;
  write(
    buffer: Uint8Array,
    offset: number,
    length: number,
    position: number,
  ): Promise<{ readonly bytesWritten: number }>;
}

export interface RawTargetFileHost {
  openRead(path: string): Promise<RandomAccessFile>;
  openWrite(path: string): Promise<RandomAccessFile>;
}

const asRandomAccessFile = (handle: FileHandle): RandomAccessFile => handle;

export class NodeRawTargetFileHost implements RawTargetFileHost {
  async openRead(path: string): Promise<RandomAccessFile> {
    return asRandomAccessFile(await open(path, "r"));
  }

  async openWrite(path: string): Promise<RandomAccessFile> {
    return asRandomAccessFile(await open(path, "r+"));
  }
}

export class RawFileImageSource implements RepeatableImageSource {
  readonly #path: string;

  constructor(path: string) {
    this.#path = path;
  }

  open(cancellation: AbortSignal): ImageByteStream {
    const stream = createReadStream(this.#path, { signal: cancellation });
    return {
      cancel: () => { stream.destroy(); },
      chunks: stream,
      completion: finished(stream),
    };
  }
}

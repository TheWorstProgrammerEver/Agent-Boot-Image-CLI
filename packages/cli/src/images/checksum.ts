import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";

export const sha256File = async (path: string, cancellation?: AbortSignal): Promise<string> => {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path, { signal: cancellation })) {
    hash.update(chunk as Buffer);
  }
  return hash.digest("hex");
};

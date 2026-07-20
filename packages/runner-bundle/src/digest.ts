import { createHash } from "node:crypto";

export const sha256 = (contents: string | Uint8Array): string =>
  createHash("sha256").update(contents).digest("hex");

export const isSha256 = (value: string): boolean => /^[a-f0-9]{64}$/u.test(value);

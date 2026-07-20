import { Buffer } from "node:buffer";

import type { SpawnOutputChunk } from "@agent-boot/process";

import { adapterError } from "./errors.js";
import type { OpenSslPasswordHasherOptions, PasswordHasher } from "./model.js";

const sha512Crypt = /^\$6\$([./A-Za-z0-9]{1,16})\$[./A-Za-z0-9]{86}$/u;
const maximumOutputBytes = 256;

const passwordText = (password: Uint8Array): string => {
  const value = Buffer.from(password).toString("utf8");
  if (
    value.length === 0 || value.length > 256 ||
    value.includes("\0") || value.includes("\n") || value.includes("\r") ||
    !Buffer.from(value, "utf8").equals(Buffer.from(password))
  ) {
    throw adapterError("invalid-input", "The initial account password is invalid.");
  }
  return value;
};

export class OpenSslPasswordHasher implements PasswordHasher {
  readonly #options: OpenSslPasswordHasherOptions;

  constructor(options: OpenSslPasswordHasherOptions) {
    this.#options = options;
  }

  async hash(password: Uint8Array, existingHash?: string): Promise<string> {
    const plaintext = passwordText(password);
    const existing = existingHash === undefined ? undefined : sha512Crypt.exec(existingHash);
    if (existingHash !== undefined && existing === null) {
      throw adapterError("incompatible-image", "The existing account bootstrap is incompatible.");
    }
    const salt = existing?.[1];
    const output: Uint8Array[] = [];
    let outputBytes = 0;
    const onOutput = (chunk: SpawnOutputChunk): void => {
      if (chunk.stream !== "stdout") return;
      outputBytes += chunk.data.byteLength;
      if (outputBytes <= maximumOutputBytes) output.push(chunk.data);
    };
    let completion;
    try {
      const running = this.#options.commandHost.spawn({
        executable: "openssl",
        arguments: [
          "passwd",
          "-6",
          ...(salt === undefined ? [] : ["-salt", salt]),
          "-stdin",
        ],
        stdin: `${plaintext}\n`,
        sensitiveValues: [plaintext],
        label: "hash initial account password",
        lifetime: { policy: "managed" },
        onOutput,
        stdio: "stream",
        timeoutMs: this.#options.timeoutMs ?? 10_000,
      });
      completion = await running.completion;
    } catch {
      throw adapterError("password-hash-failed", "Initial account password hashing failed.");
    }
    if (completion.exitCode !== 0 || outputBytes > maximumOutputBytes) {
      throw adapterError("password-hash-failed", "Initial account password hashing failed.");
    }
    const hashed = Buffer.concat(output.map((bytes) => Buffer.from(bytes))).toString("utf8").trim();
    if (!sha512Crypt.test(hashed)) {
      throw adapterError("password-hash-failed", "Initial account password hashing failed.");
    }
    return hashed;
  }
}

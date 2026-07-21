import { Writable } from "node:stream";
import { createInterface } from "node:readline/promises";

import { NetworkCommandError } from "./errors.js";

export interface NetworkPrompter {
  passphrase(): Promise<string>;
  ssid(): Promise<string>;
}

class PromptOutput extends Writable {
  muted = false;

  override _write(
    chunk: string | Buffer,
    encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    if (!this.muted) process.stdout.write(chunk, encoding);
    callback();
  }
}

export class TerminalNetworkPrompter implements NetworkPrompter {
  async ssid(): Promise<string> {
    return this.question("Wi-Fi SSID: ", false);
  }

  async passphrase(): Promise<string> {
    return this.question("Wi-Fi password: ", true);
  }

  async question(label: string, secret: boolean): Promise<string> {
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      throw new NetworkCommandError("terminal-required");
    }
    const output = new PromptOutput();
    const readline = createInterface({ input: process.stdin, output, terminal: true });
    try {
      output.muted = secret;
      if (secret) process.stdout.write(label);
      const answer = await readline.question(secret ? "" : label);
      if (secret) process.stdout.write("\n");
      return answer;
    } finally {
      output.muted = false;
      readline.close();
    }
  }
}

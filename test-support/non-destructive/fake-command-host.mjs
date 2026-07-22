import { Buffer } from "node:buffer";

const success = { exitCode: 0, reason: "exit", signal: null };
const incomplete = { exitCode: 1, reason: "exit", signal: null };

const snapshot = command => ({
  ...command,
  ...(command.arguments === undefined ? {} : { arguments: [...command.arguments] }),
  ...(command.environment === undefined ? {} : { environment: { ...command.environment } }),
  ...(command.stdin === undefined
    ? {}
    : { stdin: typeof command.stdin === "string" ? command.stdin : Uint8Array.from(command.stdin) }),
  lifetime: { ...command.lifetime },
});

export class FakeProcessIdentityHost {
  #identities = new Map();

  constructor(bootId) {
    this.bootId = bootId;
  }

  add(pid) {
    const identity = {
      bootId: this.bootId,
      pid,
      processGroupId: pid,
      startTimeTicks: String(pid * 100),
    };
    this.#identities.set(pid, identity);
    return identity;
  }

  capture(pid) {
    return Promise.resolve(this.#identities.get(pid));
  }

  currentBootId() {
    return Promise.resolve(this.bootId);
  }

  matches(identity) {
    return Promise.resolve(
      JSON.stringify(this.#identities.get(identity.pid)) === JSON.stringify(identity),
    );
  }

  remove(pid) {
    this.#identities.delete(pid);
  }

  terminate(identity) {
    this.remove(identity.pid);
    return Promise.resolve(true);
  }
}

export class IntegrationCommandHost {
  #active = new Map();
  #manualChecks = 0;
  #nextPid = 40_000;

  constructor(identityHost) {
    this.identityHost = identityHost;
  }

  execCalls = [];
  providerPrompts = [];
  spawnCalls = [];

  get activeCount() {
    return this.#active.size;
  }

  exec(command) {
    this.execCalls.push({
      ...command,
      ...(command.arguments === undefined ? {} : { arguments: [...command.arguments] }),
    });
    if (command.executable !== "codex" || command.arguments?.join("\0") !== "--version") {
      return Promise.reject(new Error("Unexpected fake exec call"));
    }
    return Promise.resolve({
      exitCode: 0,
      signal: null,
      stderr: "",
      stdout: "codex-cli 0.144.6\n",
    });
  }

  spawn(command) {
    const call = snapshot(command);
    this.spawnCalls.push(call);
    if (command.label?.startsWith("runner provider ")) {
      this.providerPrompts.push(Buffer.from(command.stdin ?? []).toString("utf8"));
    }
    if (command.label?.startsWith("runner manual completion check ")) {
      this.#manualChecks += 1;
      return this.#immediate(this.#manualChecks === 1 ? incomplete : success, command);
    }
    if (command.stdio === "inherit") {
      return this.#running();
    }
    return this.#immediate(success, command);
  }

  cancelAll() {
    for (const control of [...this.#active.values()]) control.cancel("SIGTERM");
  }

  #immediate(result, command) {
    command.onOutput?.({ data: new Uint8Array(), stream: "stdout" });
    return {
      cancel: () => undefined,
      completion: Promise.resolve(result),
      pid: undefined,
      sendSignal: () => false,
    };
  }

  #running() {
    const pid = this.#nextPid;
    this.#nextPid += 1;
    this.identityHost.add(pid);
    let resolve;
    const completion = new Promise(resolvePromise => {
      resolve = resolvePromise;
    });
    let settled = false;
    const finish = result => {
      if (settled) return;
      settled = true;
      this.#active.delete(pid);
      this.identityHost.remove(pid);
      resolve(result);
    };
    const control = {
      cancel: signal => finish({
        exitCode: null,
        reason: "canceled",
        signal: signal ?? "SIGTERM",
      }),
    };
    this.#active.set(pid, control);
    return {
      cancel: control.cancel,
      completion,
      pid,
      sendSignal: () => false,
    };
  }
}

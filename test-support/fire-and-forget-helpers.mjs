export const CURRENT_BOOT_ID = "11111111-1111-4111-8111-111111111111";
export const PRIOR_BOOT_ID = "22222222-2222-4222-8222-222222222222";

export const fireAndForgetStep = (id = "start-support", command = {}) => ({
  command: {
    arguments: ["--private-marker"],
    executable: "support-service",
    ...command,
  },
  id,
  kind: "fire-and-forget",
  lifetime: "runner",
});

export const createIdentityHost = (bootId = CURRENT_BOOT_ID) => {
  const identities = new Map();
  const terminations = [];
  const identityFor = (pid, identityBootId = bootId) => ({
    bootId: identityBootId,
    pid,
    processGroupId: pid,
    startTimeTicks: String(pid * 100),
  });
  return {
    add(pid, identityBootId) {
      const identity = identityFor(pid, identityBootId);
      identities.set(pid, identity);
      return identity;
    },
    async capture(pid) {
      return identities.get(pid);
    },
    async currentBootId() {
      return bootId;
    },
    identities,
    async matches(identity) {
      return JSON.stringify(identities.get(identity.pid)) === JSON.stringify(identity);
    },
    remove(pid) {
      identities.delete(pid);
    },
    async terminate(identity, signal) {
      terminations.push({ identity, signal });
      identities.delete(identity.pid);
      return true;
    },
    terminations,
  };
};

const snapshot = command => ({
  ...command,
  ...(command.arguments === undefined ? {} : { arguments: [...command.arguments] }),
  ...(command.environment === undefined ? {} : { environment: { ...command.environment } }),
  lifetime: { ...command.lifetime },
});

export class ScriptedSpawnHost {
  readonlyCalls = [];
  #scripts = [];

  constructor(identityHost) {
    this.identityHost = identityHost;
  }

  get spawnCalls() {
    return this.readonlyCalls;
  }

  scriptError(error) {
    this.#scripts.push({ error });
    return this;
  }

  scriptImmediate(result, options = {}) {
    this.#scripts.push({ kind: "immediate", options, result });
    return this;
  }

  scriptRunning(pid, options = {}) {
    this.#scripts.push({ kind: "running", options, pid });
    return this;
  }

  complete(index, result = { exitCode: 17, reason: "exit", signal: null }) {
    const running = this.readonlyCalls[index]?.control;
    if (running === undefined) throw new Error("No running command at index");
    running.complete(result);
  }

  spawn(command) {
    const script = this.#scripts.shift();
    if (script === undefined) throw new Error("Missing spawn script");
    if ("error" in script) throw script.error;
    script.options.beforeSpawn?.(this);
    if (script.kind === "immediate") {
      if (script.options.pid !== undefined) this.identityHost.add(script.options.pid);
      this.readonlyCalls.push(snapshot(command));
      return {
        cancel: () => undefined,
        completion: Promise.resolve(script.result),
        pid: script.options.pid,
        sendSignal: () => false,
      };
    }

    this.identityHost.add(script.pid);
    let resolve;
    const completion = new Promise(resolvePromise => {
      resolve = resolvePromise;
    });
    let cancellationListener;
    let settled = false;
    const control = {
      cancelSignals: [],
      complete: result => {
        if (settled) return;
        settled = true;
        if (cancellationListener !== undefined) {
          command.cancellation?.removeEventListener("abort", cancellationListener);
        }
        this.identityHost.remove(script.pid);
        resolve(result);
      },
    };
    const cancel = signal => {
      if (settled) return;
      control.cancelSignals.push(signal ?? "SIGTERM");
      control.complete({ exitCode: null, reason: "canceled", signal: signal ?? "SIGTERM" });
    };
    if (command.cancellation !== undefined) {
      cancellationListener = () => cancel();
      if (command.cancellation.aborted) cancellationListener();
      else command.cancellation.addEventListener("abort", cancellationListener, { once: true });
    }
    this.readonlyCalls.push({ ...snapshot(command), control });
    return {
      cancel,
      completion,
      pid: script.pid,
      sendSignal: () => false,
    };
  }
}

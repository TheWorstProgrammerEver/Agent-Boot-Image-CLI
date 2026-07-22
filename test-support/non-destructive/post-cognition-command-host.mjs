import { Buffer } from "node:buffer";
import { chmod, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const success = { exitCode: 0, reason: "exit", signal: null };
const failed = { exitCode: 17, reason: "exit", signal: null };
const incomplete = { exitCode: 1, reason: "exit", signal: null };

const writeExecutable = async path => {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  await chmod(path, 0o755);
};

const fileMode = async path => (await stat(path)).mode & 0o777;

export class PostCognitionIdentityHost {
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

export class PostCognitionCommandHost {
  #active = new Map();
  #fixture;
  #nextPid = 50_000;
  #runtime;

  constructor(fixture, identityHost, runtime) {
    this.#fixture = fixture;
    this.identityHost = identityHost;
    this.#runtime = runtime;
  }

  execCalls = [];
  providerPrompts = [];
  spawnCalls = [];

  get activeCount() {
    return this.#active.size;
  }

  exec(command) {
    this.execCalls.push({ arguments: command.arguments, executable: command.executable });
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
    const call = {
      arguments: [...(command.arguments ?? [])],
      executable: command.executable,
      label: command.label,
    };
    this.spawnCalls.push(call);
    this.#runtime.executions.push(call.label ?? "unlabelled");

    if (command.label?.startsWith("runner manual completion check ")) {
      this.#runtime.manualChecks += 1;
      return this.#immediate(this.#runtime.manualChecks === 1 ? incomplete : success);
    }
    if (command.stdio === "inherit") return this.#running();
    return {
      cancel: () => undefined,
      completion: this.#execute(command),
      pid: undefined,
      sendSignal: () => false,
    };
  }

  cancelAll() {
    for (const control of [...this.#active.values()]) control.cancel("SIGTERM");
  }

  async #execute(command) {
    const label = command.label ?? "";
    if (label === "runner step configure-interactive-codex") {
      const config = join(this.#fixture.homeDirectory, ".codex", "config.toml");
      await mkdir(dirname(config), { recursive: true });
      await writeFile(
        config,
        'approval_policy = "never"\nsandbox_mode = "danger-full-access"\n',
        { mode: 0o600 },
      );
    } else if (label === "runner step install-git") {
      await writeExecutable(join(this.#fixture.systemRoot, "usr", "bin", "git"));
    } else if (label.startsWith("runner step sync-")) {
      await this.#syncRepository(command.arguments ?? []);
    } else if (label === "runner step install-github-app-helpers") {
      await this.#installGithubHelpers();
    } else if (label === "runner step install-codex-skills") {
      if (this.#runtime.skillsFailuresRemaining > 0) {
        this.#runtime.skillsFailuresRemaining -= 1;
        return failed;
      }
      const skill = join(
        this.#fixture.homeDirectory,
        ".codex",
        "skills",
        "manage-durable-notes",
        "SKILL.md",
      );
      await mkdir(dirname(skill), { recursive: true });
      await writeFile(skill, "# fixture installed skill\n", "utf8");
    } else if (label === "runner step install-mind-maintainer") {
      const systemdRoot = join(this.#fixture.systemRoot, "etc", "systemd", "system");
      await mkdir(systemdRoot, { recursive: true });
      await Promise.all([
        writeFile(
          join(systemdRoot, "codex-agent-mind-maintainer.service"),
          "[Service]\nType=oneshot\n",
        ),
        writeFile(
          join(systemdRoot, "codex-agent-mind-maintainer.timer"),
          "[Timer]\nOnUnitInactiveSec=6h\n",
        ),
        writeFile(join(systemdRoot, "codex-agent-mind-maintainer.enabled"), "active\n"),
      ]);
    } else if (label === "runner provider codex step run-post-cognition-review") {
      this.providerPrompts.push(Buffer.from(command.stdin ?? []).toString("utf8"));
      await writeFile(
        join(this.#fixture.workingDirectory, "post-cognition-review.md"),
        "# Post-cognition review\n\nAll deterministic prerequisites are present.\n",
      );
    } else if (label === "runner step verify-post-cognition-setup") {
      await this.#verify(command.arguments ?? []);
    }
    return success;
  }

  async #installGithubHelpers() {
    const configRoot = join(this.#fixture.homeDirectory, ".config", "codex-github");
    if (await fileMode(join(configRoot, "app.pem")) !== 0o600) throw new Error("unsafe key");
    if (await fileMode(join(configRoot, "codex.env")) !== 0o600) throw new Error("unsafe config");
    const configuration = await readFile(join(configRoot, "codex.env"), "utf8");
    if (!configuration.includes("GITHUB_APP_ID=") ||
        !configuration.includes("GITHUB_INSTALLATION_ID=")) {
      throw new Error("incomplete config");
    }
    for (const helper of ["codex-github-token", "codex-github-askpass", "codex-gh"]) {
      await writeExecutable(join(this.#fixture.homeDirectory, ".local", "bin", helper));
    }
  }

  async #syncRepository(arguments_) {
    const [, revision, relativeDestination] = arguments_;
    if (revision === undefined || relativeDestination === undefined) {
      throw new Error("invalid repository fake input");
    }
    const checkout = join(this.#fixture.homeDirectory, relativeDestination);
    await mkdir(join(checkout, ".git"), { recursive: true });
    await writeFile(join(checkout, ".agent-boot-revision"), `${revision}\n`);
  }

  async #verify(revisions) {
    const [github, skills, maintainer] = revisions;
    const checks = [
      ["workspace/codex-agent-setup-github", github],
      ["workspace/codex-skills", skills],
      ["workspace/codex-agent-setup-mind-maintainer", maintainer],
    ];
    for (const [relativePath, expected] of checks) {
      const actual = await readFile(
        join(this.#fixture.homeDirectory, relativePath, ".agent-boot-revision"),
        "utf8",
      );
      if (actual.trim() !== expected) throw new Error("revision mismatch");
    }
    await Promise.all([
      stat(join(this.#fixture.systemRoot, "usr", "bin", "git")),
      stat(join(this.#fixture.homeDirectory, ".local", "bin", "codex-gh")),
      stat(join(
        this.#fixture.homeDirectory,
        ".codex",
        "skills",
        "manage-durable-notes",
        "SKILL.md",
      )),
      stat(join(
        this.#fixture.systemRoot,
        "etc",
        "systemd",
        "system",
        "codex-agent-mind-maintainer.enabled",
      )),
      stat(join(this.#fixture.workingDirectory, "post-cognition-review.md")),
    ]);
  }

  #immediate(result) {
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
    const completion = new Promise(resolvePromise => { resolve = resolvePromise; });
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

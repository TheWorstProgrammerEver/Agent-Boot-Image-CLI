import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

import {
  NodeStateFileSystem,
  RunnerStateStore,
  TestClock,
  identifyRunnerPlan,
} from "@agent-boot/runner";

export const createStateFixture = async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-boot-runner-state-"));
  const path = join(root, "state", "runner-checkpoint.json");
  const clock = new TestClock("2026-07-19T00:00:00.000Z");
  const serializedPlan = '{"schemaVersion":1,"agentId":"test-agent","providers":[],"steps":[]}\n';
  const plan = identifyRunnerPlan(
    { agentId: "test-agent", schemaVersion: 1 },
    serializedPlan,
  );
  return {
    cleanup: () => rm(root, { force: true, recursive: true }),
    clock,
    path,
    plan,
    root,
    store: new RunnerStateStore({ clock, path }),
  };
};

export const readCheckpoint = async path => JSON.parse(await readFile(path, "utf8"));

export const writeCheckpoint = async (path, value, mode = 0o600) => {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, typeof value === "string" ? value : `${JSON.stringify(value)}\n`, { mode });
  await chmod(path, mode);
};

export const checkpointMode = async path => (await stat(path)).mode & 0o777;

export const checkpointTempNames = async path => {
  const directory = dirname(path);
  try {
    const names = await readdir(directory);
    const prefix = `.${basename(path)}.`;
    return names.filter(name => name.startsWith(prefix) && name.endsWith(".tmp"));
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
};

export class FaultInjectingStateFileSystem extends NodeStateFileSystem {
  constructor(observer) {
    super();
    this.observer = observer;
  }

  notify(stage, path) {
    this.observer({ path, stage });
  }

  async open(path, flags, mode) {
    this.notify("before-open", path);
    const handle = await super.open(path, flags, mode);
    this.notify("after-open", path);
    return {
      close: async () => handle.close(),
      sync: async () => {
        this.notify("before-sync", path);
        await handle.sync();
        this.notify("after-sync", path);
      },
      writeFile: async contents => {
        this.notify("before-write", path);
        await handle.writeFile(contents);
        this.notify("after-write", path);
      },
    };
  }

  async rename(from, to) {
    this.notify("before-rename", from);
    await super.rename(from, to);
    this.notify("after-rename", to);
  }

  async readFile(path, encoding) {
    this.notify("before-read", path);
    const contents = await super.readFile(path, encoding);
    this.notify("after-read", path);
    return contents;
  }

  async unlink(path) {
    this.notify("before-unlink", path);
    await super.unlink(path);
    this.notify("after-unlink", path);
  }
}

export const injectedFailure = (code = "EIO") => Object.assign(new Error("injected"), { code });

#!/usr/bin/env node
import { NodeSpawnAdapter } from "@agent-boot/process";

import {
  createNodeCodexBootstrapCommandRuntime,
  runCodexBootstrapCommand,
} from "./command.js";

const uid = process.getuid?.();
const gid = process.getgid?.();
if (uid === undefined || gid === undefined) process.exitCode = 1;
else {
  try {
    await runCodexBootstrapCommand(
      process.argv.slice(2),
      createNodeCodexBootstrapCommandRuntime({
        environment: process.env,
        gid,
        spawnHost: new NodeSpawnAdapter(),
        uid,
      }),
    );
  } catch {
    process.exitCode = 1;
  }
}

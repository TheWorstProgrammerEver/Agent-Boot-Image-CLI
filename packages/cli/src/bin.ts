#!/usr/bin/env node
import { LinuxDriveInspector } from "@agent-boot/os-linux";
import { NodeSpawnAdapter } from "@agent-boot/process";

import { runCreateAgent } from "./validate-command.js";

process.exitCode = await runCreateAgent(process.argv.slice(2), {
  stdout: (line) => { console.log(line); },
  stderr: (line) => { console.error(line); },
}, {
  driveInspector: new LinuxDriveInspector(new NodeSpawnAdapter()),
});

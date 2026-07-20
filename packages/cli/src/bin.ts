#!/usr/bin/env node
import { LinuxDriveInspector } from "@agent-boot/os-linux";
import { NodeSpawnAdapter } from "@agent-boot/process";

import { runCreateAgent } from "./validate-command.js";
import {
  createDryRunImageWorkflowDependencies,
  createLiveImageWorkflowDependencies,
} from "./image/live.js";

const arguments_ = process.argv.slice(2);
const imageWorkflow = arguments_[0] === "image"
  ? arguments_.includes("--dry-run")
    ? createDryRunImageWorkflowDependencies()
    : createLiveImageWorkflowDependencies()
  : undefined;
const driveInspector = arguments_[0] === "drives"
  ? new LinuxDriveInspector(new NodeSpawnAdapter())
  : undefined;

process.exitCode = await runCreateAgent(arguments_, {
  stdout: (line) => { console.log(line); },
  stderr: (line) => { console.error(line); },
}, {
  ...(driveInspector === undefined ? {} : { driveInspector }),
  ...(imageWorkflow === undefined ? {} : { imageWorkflow }),
});

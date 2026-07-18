#!/usr/bin/env node
import { runCreateAgent } from "./validate-command.js";

process.exitCode = await runCreateAgent(process.argv.slice(2), {
  stdout: (line) => { console.log(line); },
  stderr: (line) => { console.error(line); },
});

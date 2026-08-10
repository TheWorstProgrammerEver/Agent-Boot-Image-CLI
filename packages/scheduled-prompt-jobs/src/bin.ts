#!/usr/bin/env node
import { runPromptJobCommand } from "./command.js";

process.exitCode = await runPromptJobCommand(process.argv.slice(2), {
  stderr: line => { process.stderr.write(`${line}\n`); },
  stdout: line => { process.stdout.write(`${line}\n`); },
});

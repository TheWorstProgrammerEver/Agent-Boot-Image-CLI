import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import test from "node:test";
import { URL } from "node:url";

import {
  CREATE_AGENT_EXIT_CODE,
  runCreateAgent,
} from "../packages/cli/dist/index.js";
import {
  createDefinitionFixture,
  validDefinitionSource,
} from "../test-support/cli-definition-fixtures.mjs";

const protocolOsLockUrl = new URL(
  "../packages/protocol/fixtures/assembly/os-lock.json",
  import.meta.url,
);

const setupInputs = async (root, name = "valid-synth", source) => {
  const fixture = await createDefinitionFixture(root, name, source);
  const inputs = join(root, `${name}-inputs`);
  await mkdir(inputs);
  const osLock = join(inputs, "os-lock.json");
  const runtime = join(inputs, "node-runtime");
  const entrypoint = join(inputs, "runner.mjs");
  await Promise.all([
    writeFile(osLock, await readFile(protocolOsLockUrl)),
    writeFile(runtime, "runtime\n", "utf8"),
    writeFile(entrypoint, "export {};\n", "utf8"),
  ]);
  return { ...fixture, entrypoint, osLock, runtime };
};

const argumentsFor = (fixture, output, ...extra) => [
  "synth",
  "--definition", fixture.definitionPath,
  "--output", output,
  "--os-lock", fixture.osLock,
  "--runner-runtime", fixture.runtime,
  "--runner-entrypoint", fixture.entrypoint,
  ...extra,
];

const run = async (arguments_) => {
  const stdout = [];
  const stderr = [];
  const exitCode = await runCreateAgent(arguments_, {
    stdout: (line) => { stdout.push(line); },
    stderr: (line) => { stderr.push(line); },
  });
  return { exitCode, stderr, stdout, output: [...stdout, ...stderr].join("\n") };
};

test("create-agent synth CLI", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "agent-boot-cli-synth-test-"));
  try {
    const fixture = await setupInputs(root);

    await context.test("prints a redacted plan without writing", async () => {
      const output = join(root, "plan-output");
      const result = await run(argumentsFor(fixture, output, "--plan"));
      assert.equal(result.exitCode, CREATE_AGENT_EXIT_CODE.valid);
      assert.match(result.output, /secret contents excluded/u);
      assert.match(result.output, /Plan only/u);
      assert.doesNotMatch(result.output, /fixture-secret-must-not-appear|app-key|refs\//u);
      await assert.rejects(access(output));
    });

    await context.test("writes a schema-valid redacted assembly", async () => {
      const output = join(root, "assembly");
      const result = await run(argumentsFor(fixture, output));
      assert.equal(result.exitCode, CREATE_AGENT_EXIT_CODE.valid, result.output);
      const manifest = await readFile(join(output, "manifest.json"), "utf8");
      const runnerPlan = await readFile(join(output, "runner-plan.json"), "utf8");
      assert.match(manifest, /"schemaVersion": 1/u);
      assert.match(runnerPlan, /"secretId": "app-key"/u);
      assert.doesNotMatch(`${manifest}\n${runnerPlan}`, /fixture-secret-must-not-appear/u);
      await assert.rejects(access(join(output, "secrets")));

      const repeated = await run(argumentsFor(fixture, output));
      assert.equal(repeated.exitCode, CREATE_AGENT_EXIT_CODE.outputExists);
      assert.match(repeated.output, /--replace explicitly/u);
      const replaced = await run(argumentsFor(fixture, output, "--replace"));
      assert.equal(replaced.exitCode, CREATE_AGENT_EXIT_CODE.valid, replaced.output);
    });

    await context.test("uses documented invalid-input, operational, and usage exits", async () => {
      const badLock = join(root, "bad-lock.json");
      await writeFile(badLock, '{"password":"diagnostic-secret"}\n', "utf8");
      const invalidFixture = { ...fixture, osLock: badLock };
      const invalid = await run(argumentsFor(invalidFixture, join(root, "bad-lock-output")));
      assert.equal(invalid.exitCode, CREATE_AGENT_EXIT_CODE.invalidSynthesisInput);
      assert.doesNotMatch(invalid.output, /diagnostic-secret|password/u);

      const operationalFixture = { ...fixture, runtime: join(root, "missing-runtime") };
      const operational = await run(argumentsFor(
        operationalFixture,
        join(root, "missing-runtime-output"),
      ));
      assert.equal(operational.exitCode, CREATE_AGENT_EXIT_CODE.synthesisFailure);

      const usage = await run(["synth", "--definition", fixture.definitionPath]);
      assert.equal(usage.exitCode, CREATE_AGENT_EXIT_CODE.usage);
    });

    await context.test("rejects definition references outside the definition root", async () => {
      const outsidePath = join(root, "outside.json");
      await writeFile(outsidePath, "{}", "utf8");
      const traversing = await setupInputs(
        root,
        "traversing",
        validDefinitionSource({ assetSource: "../outside.json" }),
      );
      const result = await run(argumentsFor(traversing, join(root, "traversal-output")));
      assert.equal(result.exitCode, CREATE_AGENT_EXIT_CODE.invalidSynthesisInput);
      assert.match(result.output, /beneath the definition root/u);
      assert.doesNotMatch(result.output, /outside\.json/u);
    });

    await context.test("executable CLI returns success and writes only the requested output", async () => {
      const output = join(root, "executable-output");
      const result = spawnSync(
        process.execPath,
        ["packages/cli/dist/bin.js", ...argumentsFor(fixture, output)],
        { cwd: process.cwd(), encoding: "utf8" },
      );
      assert.equal(result.status, CREATE_AGENT_EXIT_CODE.valid, result.stderr);
      assert.match(result.stdout, /Assembly written successfully/u);
      assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /fixture-secret-must-not-appear/u);
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

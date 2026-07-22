import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL, URL } from "node:url";
import test from "node:test";

import { loadTrustedDefinition, resolveDefinitionOsLock, runCreateAgent } from "@agent-boot/cli";
import { osCatalog } from "@agent-boot/os-adapters";
import { synthesizeAssembly } from "@agent-boot/synth";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const exampleSource = join(repositoryRoot, "examples", "definitive-agent");
const definitionModuleUrl = pathToFileURL(join(
  repositoryRoot,
  "packages",
  "definition",
  "dist",
  "index.js",
)).href;

const prepareExample = async (root, mutatePrompt) => {
  const exampleRoot = join(root, "example");
  await cp(exampleSource, exampleRoot, { recursive: true });
  const definitionPath = join(exampleRoot, "definition.ts");
  const definition = (await readFile(definitionPath, "utf8"))
    .replace('from "@agent-boot/definition";', `from ${JSON.stringify(definitionModuleUrl)};`);
  await writeFile(definitionPath, definition, "utf8");
  const secretRoot = join(exampleRoot, "secrets");
  await mkdir(secretRoot);
  await Promise.all([
    writeFile(join(secretRoot, "account-authentication"), "fake-account-password", { mode: 0o600 }),
    writeFile(join(secretRoot, "network-authentication"), "fake-wifi-passphrase", { mode: 0o600 }),
    writeFile(join(secretRoot, "repository-credential"), "fake-repository-credential", { mode: 0o600 }),
  ]);
  if (mutatePrompt !== undefined) {
    const promptPath = join(exampleRoot, "prompts", "bootstrap-agent.md");
    await writeFile(promptPath, mutatePrompt(await readFile(promptPath, "utf8")), "utf8");
  }
  return definitionPath;
};

const synthesizeExample = async definitionPath => {
  const loaded = await loadTrustedDefinition(definitionPath);
  return synthesizeAssembly(loaded.definition, {
    osLock: resolveDefinitionOsLock(loaded.definition),
    runnerArtifacts: {
      entrypoint: Buffer.from("export {};\n", "utf8"),
      runtime: Buffer.from("fake-private-runtime\n", "utf8"),
    },
  });
};

test("release documentation checker passes from the repository root", () => {
  const result = spawnSync(process.execPath, ["scripts/check-docs-release.mjs"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});

test("public definition scripts pass shell syntax validation", () => {
  for (const script of ["prepare-workspace.sh", "verify-bootstrap.sh"]) {
    const result = spawnSync("bash", ["-n", join(exampleSource, "scripts", script)], {
      encoding: "utf8",
    });
    assert.equal(result.status, 0, `${script}: ${result.stderr}`);
  }
});

test("public deterministic recipe scripts execute against documented artifacts", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-boot-docs-runtime-"));
  try {
    const home = join(root, "home", "my-user");
    await mkdir(join(home, ".config", "repository"), { recursive: true });
    const environment = { ...process.env, HOME: home };
    const prepare = spawnSync(
      "bash",
      [join(exampleSource, "scripts", "prepare-workspace.sh")],
      { encoding: "utf8", env: environment },
    );
    assert.equal(prepare.status, 0, prepare.stderr);

    await Promise.all([
      writeFile(
        join(home, "workspace", "bootstrap-report.txt"),
        "agent bootstrap verified\n",
        { mode: 0o600 },
      ),
      writeFile(
        join(home, ".config", "repository", "credential"),
        "fake-repository-credential",
        { mode: 0o600 },
      ),
    ]);
    const verify = spawnSync(
      "bash",
      [join(exampleSource, "scripts", "verify-bootstrap.sh")],
      { encoding: "utf8", env: environment },
    );
    assert.equal(verify.status, 0, verify.stderr);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("operator guide embeds the exact maintained public definition", async () => {
  const operatorGuide = await readFile(
    join(repositoryRoot, "docs", "operator", "README.md"),
    "utf8",
  );
  const documentedDefinition = operatorGuide.match(/```ts\n([\s\S]*?)\n```/u)?.[1];
  assert.ok(documentedDefinition, "operator guide is missing its TypeScript definition");
  assert.equal(
    `${documentedDefinition}\n`,
    await readFile(join(exampleSource, "definition.ts"), "utf8"),
  );
});

test("documented CLI flags agree with executable usage output", async () => {
  const lines = [];
  const io = {
    stderr: line => lines.push(line),
    stdout: line => lines.push(line),
  };
  await runCreateAgent([], io);
  await runCreateAgent(["synth"], io);
  await runCreateAgent(["image"], io, { imageWorkflow: {} });
  const usage = lines.filter(line => line.startsWith("Usage:"));
  assert.equal(usage.length, 3);

  const documentation = [
    await readFile(join(repositoryRoot, "README.md"), "utf8"),
    await readFile(join(repositoryRoot, "packages", "cli", "README.md"), "utf8"),
    await readFile(join(repositoryRoot, "docs", "operator", "README.md"), "utf8"),
  ].join("\n");
  for (const commandUsage of usage) {
    for (const token of commandUsage.match(/(?:validate|synth|drives|image|--[a-z-]+)/gu) ?? []) {
      assert.match(documentation, new RegExp(token, "u"));
    }
  }
});

test("supported matrix matches the sole curated catalog entry", async () => {
  assert.equal(osCatalog.entries.length, 1);
  const [entry] = osCatalog.entries;
  const matrix = await readFile(join(repositoryRoot, "docs", "supported-matrix.md"), "utf8");
  for (const value of [
    entry.catalogId,
    entry.lockId,
    entry.artifact.identity,
    String(entry.artifact.byteLength),
    entry.artifact.checksum.digest,
    ...entry.supportedBoards,
  ]) assert.match(matrix, new RegExp(value, "u"));
});

test("public definition validates and synthesizes with synthetic operator inputs", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-boot-docs-example-"));
  try {
    const definitionPath = await prepareExample(root);
    const assembly = await synthesizeExample(definitionPath);
    const stepIds = assembly.documents.runnerPlan.steps.map(step => step.id);
    assert.ok(stepIds.indexOf("codex-authenticate-device") < stepIds.indexOf("prepare-workspace"));
    assert.ok(stepIds.indexOf("prepare-workspace") < stepIds.indexOf("run-codex-bootstrap"));
    assert.ok(stepIds.indexOf("run-codex-bootstrap") < stepIds.indexOf("verify-codex-bootstrap"));
    assert.ok(assembly.documents.runnerPlan.steps.every(step => step.kind !== "fire-and-forget"));
    assert.equal(stepIds.includes("start-agent-support-service"), false);
    assert.equal(assembly.documents.osLock.catalogId, "raspberry-pi-os-lite-trixie-arm64-2026-06-18");
    assert.doesNotMatch(
      JSON.stringify(assembly.documents),
      /fake-account-password|fake-wifi-passphrase|fake-repository-credential/u,
    );
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("public definition fails closed for missing and undeclared prompt variables", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-boot-docs-prompt-"));
  try {
    const missing = await prepareExample(join(root, "missing"), prompt =>
      prompt.replace("{{agent-name}}", "the agent"));
    await assert.rejects(synthesizeExample(missing), error => {
      assert.match(error.message, /declares unused variable/u);
      assert.doesNotMatch(error.message, /agent bootstrap verified/u);
      return true;
    });

    const undeclared = await prepareExample(join(root, "undeclared"), prompt =>
      `${prompt}\nReview {{undeclared-value}}.\n`);
    await assert.rejects(synthesizeExample(undeclared), error => {
      assert.match(error.message, /undeclared variable/u);
      assert.doesNotMatch(error.message, /agent bootstrap verified/u);
      return true;
    });
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

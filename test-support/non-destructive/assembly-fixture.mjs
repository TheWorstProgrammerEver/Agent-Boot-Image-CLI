import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL, URL } from "node:url";

import { loadTrustedDefinition, resolveDefinitionOsLock } from "@agent-boot/cli";
import { synthesizeAssembly } from "@agent-boot/synth";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const exampleRoot = join(repositoryRoot, "examples", "definitive-agent");
const definitionModuleUrl = pathToFileURL(join(
  repositoryRoot,
  "packages",
  "definition",
  "dist",
  "index.js",
)).href;

export const PRIVATE_MARKER = "integration-private-value-must-not-appear";

export const createDefinitiveDefinition = async root => {
  const directory = join(root, "definitive-agent");
  const promptDirectory = join(directory, "prompts");
  const secretDirectory = join(directory, "secrets");
  await Promise.all([
    mkdir(promptDirectory, { recursive: true }),
    mkdir(secretDirectory, { recursive: true }),
  ]);

  const source = (await readFile(join(exampleRoot, "definition.ts"), "utf8"))
    .replace('from "@agent-boot/definition";', `from ${JSON.stringify(definitionModuleUrl)};`);
  const definitionPath = join(directory, "definition.ts");
  await Promise.all([
    writeFile(definitionPath, source, "utf8"),
    writeFile(
      join(promptDirectory, "bootstrap-agent.md"),
      await readFile(join(exampleRoot, "prompts", "bootstrap-agent.md")),
    ),
    ...[
      "account-authentication",
      "network-authentication",
      "repository-credential",
    ].map(async id => {
      const path = join(secretDirectory, id);
      await writeFile(path, `${PRIVATE_MARKER}-${id}\n`, { mode: 0o600 });
      await chmod(path, 0o600);
    }),
  ]);

  return {
    definitionPath,
    loaded: await loadTrustedDefinition(definitionPath),
  };
};

export const runnerArtifacts = {
  entrypoint: Buffer.from("export {};\n", "utf8"),
  runtime: Buffer.from("private-arm64-runtime-fixture\n", "utf8"),
};

export const synthesizeDefinitiveAssembly = async loaded => {
  const osLock = resolveDefinitionOsLock(loaded.definition);
  return {
    assembly: await synthesizeAssembly(loaded.definition, {
      osLock,
      runnerArtifacts,
    }),
    osLock,
  };
};

export const assemblySha256 = assembly => {
  const hash = createHash("sha256");
  for (const file of assembly.files) {
    hash.update(file.path);
    hash.update("\0");
    hash.update(file.mode.toString(8));
    hash.update("\0");
    hash.update(file.contents);
    hash.update("\0");
  }
  return hash.digest("hex");
};

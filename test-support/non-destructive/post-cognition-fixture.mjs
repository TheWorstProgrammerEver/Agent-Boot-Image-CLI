import { Buffer } from "node:buffer";
import {
  chmod,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL, URL } from "node:url";

import { loadTrustedDefinition, resolveDefinitionOsLock } from "@agent-boot/cli";
import { RunnerStateStore } from "@agent-boot/runner";
import { synthesizeAssembly } from "@agent-boot/synth";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const exampleRoot = join(repositoryRoot, "examples", "post-cognition-agent");
const definitionModuleUrl = pathToFileURL(join(
  repositoryRoot,
  "packages",
  "definition",
  "dist",
  "index.js",
)).href;

export const POST_COGNITION_REVISIONS = {
  github: "6991bf1d5071b64d1c51d7627935d39db180863c",
  maintainer: "205e55df07046e5b0d1b654f929c38cea30bdce8",
  skills: "fd9623d030228431de345dbff770b21e474a81e2",
};

const sensitiveValues = () => {
  const appIdentifier = ["fixture", "-private-app-identifier"].join("");
  const installationIdentifier = ["fixture", "-private-installation-identifier"].join("");
  return {
    account: ["fixture-account", "-authentication-value"].join(""),
    appIdentifier,
    certificate: [
      `-----BEGIN ${["PRIVATE", "KEY"].join(" ")}-----`,
      ["fixture-key", "-material"].join(""),
      `-----END ${["PRIVATE", "KEY"].join(" ")}-----`,
    ].join("\n"),
    configuration: [
      `GITHUB_APP_ID=${appIdentifier}`,
      `GITHUB_INSTALLATION_ID=${installationIdentifier}`,
    ].join("\n"),
    deviceCode: ["FIXT", "-URE1"].join(""),
    generatedCredential: ["generated-credential", "-fixture-value"].join(""),
    hostFact: ["private-fixture-host", ".internal"].join(""),
    installationIdentifier,
    network: ["fixture-network", "-authentication-value"].join(""),
    token: [`g${"hs"}_`, "x".repeat(36)].join(""),
  };
};

const createDefinitionFixture = async (root, values) => {
  const definitionRoot = join(root, "definition");
  await Promise.all([
    mkdir(join(definitionRoot, "prompts"), { recursive: true }),
    mkdir(join(definitionRoot, "scripts"), { recursive: true }),
    mkdir(join(definitionRoot, "secrets"), { recursive: true }),
  ]);
  const source = (await readFile(join(exampleRoot, "definition.ts"), "utf8"))
    .replace('from "@agent-boot/definition";', `from ${JSON.stringify(definitionModuleUrl)};`);
  const definitionPath = join(definitionRoot, "definition.ts");
  await writeFile(definitionPath, source, "utf8");
  await cp(join(exampleRoot, "prompts"), join(definitionRoot, "prompts"), {
    recursive: true,
  });
  await cp(join(exampleRoot, "scripts"), join(definitionRoot, "scripts"), {
    recursive: true,
  });

  const secrets = new Map([
    ["account-authentication", `${values.account}\n`],
    ["network-authentication", `${values.network}\n`],
    ["github-app-private-key", `${values.certificate}\n`],
    ["github-app-configuration", `${values.configuration}\n`],
  ]);
  await Promise.all([...secrets].map(async ([id, contents]) => {
    const path = join(definitionRoot, "secrets", id);
    await writeFile(path, contents, { mode: 0o600 });
    await chmod(path, 0o600);
  }));
  return { definitionPath, secrets };
};

const materializeAssembly = async (root, assembly) => {
  for (const file of assembly.files) {
    const destination = join(root, file.path);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, file.contents, { mode: file.mode });
    await chmod(destination, file.mode);
  }
};

export const createPostCognitionFixture = async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-boot-post-cognition-"));
  const values = sensitiveValues();
  const systemRoot = join(root, "target");
  const resourceRoot = join(systemRoot, "opt", "agent-boot");
  const homeDirectory = join(systemRoot, "home", "my-user");
  const workingDirectory = join(homeDirectory, "workspace");
  const statePath = join(systemRoot, "var", "lib", "agent-boot", "state.json");

  try {
    const definitionFixture = await createDefinitionFixture(root, values);
    const loaded = await loadTrustedDefinition(definitionFixture.definitionPath);
    const assembly = await synthesizeAssembly(loaded.definition, {
      osLock: resolveDefinitionOsLock(loaded.definition),
      runnerArtifacts: {
        entrypoint: Buffer.from("export {};\n", "utf8"),
        runtime: Buffer.from("private-runtime-fixture\n", "utf8"),
      },
    });
    await materializeAssembly(resourceRoot, assembly);
    await mkdir(workingDirectory, { recursive: true });

    const bootstrapSecretRoot = join(
      systemRoot,
      "etc",
      "agent-boot",
      "bootstrap-secrets",
    );
    await mkdir(bootstrapSecretRoot, { mode: 0o700, recursive: true });
    for (const id of ["github-app-private-key", "github-app-configuration"]) {
      const path = join(bootstrapSecretRoot, id);
      await writeFile(path, definitionFixture.secrets.get(id), { mode: 0o600 });
      await chmod(path, 0o600);
    }

    return {
      assembly,
      bootstrapSecretRoot,
      cleanup: () => rm(root, { force: true, recursive: true }),
      exampleRoot,
      homeDirectory,
      manifest: assembly.documents.manifest,
      plan: assembly.documents.runnerPlan,
      resourceRoot,
      root,
      serializedPlan: Buffer.from(JSON.stringify(assembly.documents.runnerPlan), "utf8"),
      statePath,
      store: new RunnerStateStore({ path: statePath }),
      systemRoot,
      values,
      workingDirectory,
    };
  } catch (error) {
    await rm(root, { force: true, recursive: true });
    throw error;
  }
};

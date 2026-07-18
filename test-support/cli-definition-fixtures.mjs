import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const validDefinitionSource = ({
  schemaVersion = 1,
  definitionUrl = "import.meta.url",
  assetSource = "./refs/asset.json",
} = {}) => `
const definition: unknown = {
  schemaVersion: ${JSON.stringify(schemaVersion)},
  definitionUrl: ${definitionUrl},
  agent: { id: "my-agent", displayName: "My Agent" },
  operatingSystem: {
    catalogId: "raspberry-pi-os-lite-trixie-arm64",
    compatibility: { architecture: "arm64", boards: ["raspberry-pi-5"] },
  },
  account: { username: "my-user" },
  assets: [{
    kind: "asset",
    id: "agent-config",
    source: ${JSON.stringify(assetSource)},
  }],
  prompts: [{
    kind: "prompt",
    id: "install-profile",
    source: "./refs/profile.md",
    variables: [],
  }],
  steps: [
    {
      id: "prepare",
      kind: "automatic",
      command: {
        executable: {
          kind: "script",
          id: "prepare-script",
          source: "./refs/prepare.sh",
        },
        arguments: [],
      },
    },
    {
      id: "install-key",
      kind: "install-user-secret",
      secret: { kind: "secret", id: "app-key", source: "./refs/app-key" },
      destination: ".config/agent/app-key",
    },
    {
      id: "render-profile",
      kind: "prompt",
      templateId: "install-profile",
      renderedPromptId: "profile",
      retention: "ephemeral",
      variables: [],
    },
  ],
};

export default definition satisfies object;
`;

export const createDefinitionFixture = async (
  root,
  name,
  source = validDefinitionSource(),
) => {
  const directory = join(root, name);
  const references = join(directory, "refs");
  await mkdir(references, { recursive: true });
  await Promise.all([
    writeFile(join(references, "asset.json"), "{}", "utf8"),
    writeFile(join(references, "profile.md"), "Profile", "utf8"),
    writeFile(join(references, "prepare.sh"), "exit 97", "utf8"),
    writeFile(join(references, "app-key"), "fixture-secret-must-not-appear", {
      encoding: "utf8",
      mode: 0o600,
    }),
  ]);
  const definitionPath = join(directory, "agent.ts");
  await writeFile(definitionPath, source, "utf8");
  return {
    definitionPath,
    directory,
    secretPath: join(references, "app-key"),
  };
};

export const makeSecretUnreadable = async (secretPath) => {
  await chmod(secretPath, 0o000);
};

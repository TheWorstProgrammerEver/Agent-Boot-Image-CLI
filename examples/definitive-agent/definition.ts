import {
  codexProvider,
  command,
  curatedOperatingSystem,
  defineAgent,
  fireAndForget,
  fromEnvironment,
  installUserSecret,
  prompt,
  promptVariable,
  renderPrompt,
  runProvider,
  secret,
  setEnvironment,
  unsetEnvironment,
} from "@agent-boot/definition";

const accountAuthentication = secret(
  "account-authentication",
  "./secrets/account-authentication",
);
const networkAuthentication = secret(
  "network-authentication",
  "./secrets/network-authentication",
);
const repositoryCredential = secret(
  "repository-credential",
  "./secrets/repository-credential",
);
const bootstrapPrompt = prompt(
  "bootstrap-agent",
  "./prompts/bootstrap-agent.md",
  ["agent-name"],
);
const codex = codexProvider({
  authentication: { kind: "manual-device-auth", pollIntervalSeconds: 2 },
  version: "0.144.6",
  workingRoot: { scope: "user-home", path: "workspace" },
});

export default defineAgent({
  definitionUrl: import.meta.url,
  agent: { id: "my-agent", displayName: "My Agent" },
  operatingSystem: curatedOperatingSystem("raspberry-pi-os-lite-trixie-arm64", {
    architecture: "arm64",
    boards: ["raspberry-pi-5"],
  }),
  account: { username: "my-user", initialPassword: accountAuthentication },
  network: {
    hostname: "my-agent",
    wifi: {
      ssid: "<network-ssid>",
      passphrase: networkAuthentication,
    },
  },
  prompts: [bootstrapPrompt],
  providers: [codex.provider],
  steps: [
    setEnvironment("set-agent-name", "AGENT_NAME", "My Agent"),
    setEnvironment("enter-bootstrap-mode", "BOOTSTRAP_MODE", "true"),
    ...codex.bootstrapSteps,
    fireAndForget(
      "start-agent-support-service",
      command("agent-support-service", ["--foreground"]),
    ),
    installUserSecret(
      "install-repository-credential",
      repositoryCredential,
      ".config/repository/credential",
    ),
    unsetEnvironment("leave-bootstrap-mode", "BOOTSTRAP_MODE"),
    renderPrompt("render-bootstrap-prompt", bootstrapPrompt, "bootstrap-prompt", [
      promptVariable("agent-name", fromEnvironment("AGENT_NAME")),
    ]),
    runProvider("run-codex-bootstrap", codex.provider, "bootstrap-prompt"),
  ],
});

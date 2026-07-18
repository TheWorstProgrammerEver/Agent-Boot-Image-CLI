import {
  asset,
  automatic,
  command,
  curatedOperatingSystem,
  executableProvider,
  fireAndForget,
  fromEnvironment,
  fromSecret,
  installUserSecret,
  manual,
  prompt,
  promptVariable,
  renderPrompt,
  runProvider,
  script,
  secret,
  setEnvironment,
  unsetEnvironment,
} from "../packages/definition/dist/index.js";

export const validDefinitionInput = () => {
  const accountPassword = secret("account-password", "./secrets/account-password");
  const wifiPassphrase = secret("wifi-passphrase", "./secrets/wifi-passphrase");
  const callbackSecret = secret("callback-secret", "./secrets/callback-token");
  const appKey = secret("app-key", "./secrets/app-key.pem");
  const setupScript = script("setup-script", "./scripts/../scripts/setup.sh");
  const profilePrompt = prompt("install-profile", "./prompts/install-profile.md", [
    "agent-name",
    "callback-secret",
  ]);
  const codex = executableProvider("codex", "codex", ["exec", "-"]);

  return {
    definitionUrl: "file:///workspace/definitions/my-agent.ts",
    agent: { id: "my-agent", displayName: "My Agent" },
    operatingSystem: curatedOperatingSystem("raspberry-pi-os-lite-trixie-arm64", {
      architecture: "arm64",
      boards: ["raspberry-pi-5"],
    }),
    account: { username: "my-user", initialPassword: accountPassword },
    network: {
      hostname: "my-agent",
      wifi: { ssid: "Example Network", passphrase: wifiPassphrase },
    },
    assets: [
      asset("agent-config", "./assets/agent.json", {
        placement: { scope: "user-home", path: ".config/agent/config.json" },
      }),
    ],
    prompts: [profilePrompt],
    providers: [codex],
    steps: [
      setEnvironment("set-agent-name", "AGENT_NAME", "My Agent"),
      unsetEnvironment("clear-bootstrap-mode", "BOOTSTRAP_MODE"),
      automatic("run-setup", command(setupScript, ["--non-interactive"])),
      manual(
        "authenticate",
        command("codex", ["login", "--device-auth"]),
        command("codex", ["login", "status"]),
        2,
      ),
      fireAndForget("start-helper", command("helper-daemon", ["--foreground"])),
      installUserSecret("install-app-key", appKey, ".config/codex-github/app.pem"),
      renderPrompt("render-profile", profilePrompt, "rendered-profile", [
        promptVariable("agent-name", fromEnvironment("AGENT_NAME")),
        promptVariable("callback-secret", fromSecret(callbackSecret)),
      ]),
      runProvider("apply-profile", codex, "rendered-profile"),
    ],
  };
};

export const clone = (value) => JSON.parse(JSON.stringify(value));

import {
  automatic,
  codexProvider,
  command,
  curatedOperatingSystem,
  defineAgent,
  fromEnvironment,
  installUserSecret,
  prompt,
  promptVariable,
  renderPrompt,
  runProvider,
  script,
  secret,
  setEnvironment,
} from "@agent-boot/definition";

const CODEX_SKILLS_REVISION = "fd9623d030228431de345dbff770b21e474a81e2";
const GITHUB_HELPERS_REVISION = "6991bf1d5071b64d1c51d7627935d39db180863c";
const MIND_MAINTAINER_REVISION = "205e55df07046e5b0d1b654f929c38cea30bdce8";
const SETUP_REPOSITORY =
  "https://github.com/TheWorstProgrammerEver/Codex-Agent-Setup.git";
const SKILLS_REPOSITORY =
  "https://github.com/TheWorstProgrammerEver/codex-skills.git";

const accountAuthentication = secret(
  "account-authentication",
  "./secrets/account-authentication",
);
const networkAuthentication = secret(
  "network-authentication",
  "./secrets/network-authentication",
);
const githubAppPrivateKey = secret(
  "github-app-private-key",
  "./secrets/github-app-private-key",
);
const githubAppConfiguration = secret(
  "github-app-configuration",
  "./secrets/github-app-configuration",
);
const configureInteractiveCodex = script(
  "configure-interactive-codex",
  "./scripts/configure-interactive-codex.sh",
);
const installGit = script("install-git", "./scripts/install-git.sh");
const syncRepository = script("sync-repository", "./scripts/sync-repository.sh");
const installGithubHelpers = script(
  "install-github-app-helpers",
  "./scripts/install-github-app-helpers.sh",
);
const installSkills = script("install-codex-skills", "./scripts/install-codex-skills.sh");
const installMindMaintainer = script(
  "install-mind-maintainer",
  "./scripts/install-mind-maintainer.sh",
);
const verifySetup = script(
  "verify-post-cognition-setup",
  "./scripts/verify-post-cognition-setup.sh",
);
const reviewPrompt = prompt(
  "review-post-cognition-setup",
  "./prompts/review-post-cognition-setup.md",
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
  prompts: [reviewPrompt],
  providers: [codex.provider],
  steps: [
    setEnvironment("set-agent-name", "AGENT_NAME", "My Agent"),
    ...codex.bootstrapSteps,
    automatic(
      "configure-interactive-codex",
      command(configureInteractiveCodex),
    ),
    automatic("install-git", command(installGit)),
    installUserSecret(
      "install-github-app-private-key",
      githubAppPrivateKey,
      ".config/codex-github/app.pem",
    ),
    installUserSecret(
      "install-github-app-configuration",
      githubAppConfiguration,
      ".config/codex-github/codex.env",
    ),
    automatic(
      "sync-github-helper-source",
      command(syncRepository, [
        SETUP_REPOSITORY,
        GITHUB_HELPERS_REVISION,
        "workspace/codex-agent-setup-github",
      ]),
    ),
    automatic(
      "install-github-app-helpers",
      command(installGithubHelpers, ["workspace/codex-agent-setup-github"]),
    ),
    automatic(
      "sync-codex-skills-repository",
      command(syncRepository, [
        SKILLS_REPOSITORY,
        CODEX_SKILLS_REVISION,
        "workspace/codex-skills",
      ]),
    ),
    automatic(
      "install-codex-skills",
      command(installSkills, ["workspace/codex-skills"]),
    ),
    automatic(
      "sync-mind-maintainer-source",
      command(syncRepository, [
        SETUP_REPOSITORY,
        MIND_MAINTAINER_REVISION,
        "workspace/codex-agent-setup-mind-maintainer",
      ]),
    ),
    automatic(
      "install-mind-maintainer",
      command(installMindMaintainer, [
        "workspace/codex-agent-setup-mind-maintainer",
      ]),
    ),
    renderPrompt(
      "render-post-cognition-review",
      reviewPrompt,
      "post-cognition-review",
      [promptVariable("agent-name", fromEnvironment("AGENT_NAME"))],
    ),
    runProvider("run-post-cognition-review", codex.provider, "post-cognition-review"),
    automatic(
      "verify-post-cognition-setup",
      command(verifySetup, [
        GITHUB_HELPERS_REVISION,
        CODEX_SKILLS_REVISION,
        MIND_MAINTAINER_REVISION,
      ]),
    ),
  ],
});

import {
  automatic,
  command,
  curatedOperatingSystem,
  defineAgent,
  executableProvider,
  fireAndForget,
  fromEnvironment,
  installUserSecret,
  manual,
  prompt,
  promptVariable,
  renderPrompt,
  runProvider,
  secret,
  setEnvironment,
  type AgentDefinition,
  type SequenceStep,
  type SequenceStepInput,
} from "../src/index.js";

const password = secret("account-password", "./secrets/password");
const template = prompt("profile", "./prompts/profile.md", ["agent-name"]);
const codex = executableProvider("codex", "codex", ["exec", "-"]);

export const validDefinition: AgentDefinition = defineAgent({
  definitionUrl: import.meta.url,
  agent: { id: "my-agent", displayName: "My Agent" },
  operatingSystem: curatedOperatingSystem("raspberry-pi-os-lite-trixie-arm64", {
    architecture: "arm64",
    boards: ["raspberry-pi-5"],
  }),
  account: { username: "my-user", initialPassword: password },
  prompts: [template],
  providers: [codex],
  steps: [
    setEnvironment("set-name", "AGENT_NAME", "My Agent"),
    automatic("prepare", command("prepare-agent")),
    manual("login", command("codex", ["login"]), command("codex", ["login", "status"])),
    fireAndForget("helper", command("helper")),
    installUserSecret("install-password", password, ".config/example/password"),
    renderPrompt("render-profile", template, "rendered-profile", [
      promptVariable("agent-name", fromEnvironment("AGENT_NAME")),
    ]),
    runProvider("apply-profile", codex, "rendered-profile"),
  ],
});

export const describeStep = (step: SequenceStep): string => {
  switch (step.kind) {
    case "environment": return step.key;
    case "automatic": return String(step.command.executable);
    case "manual": return String(step.completionCheck.executable);
    case "fire-and-forget": return step.lifetime;
    case "install-user-secret": return step.secretId;
    case "prompt": return step.templateId;
    case "provider": return step.providerId;
  }
};

// @ts-expect-error environment keys are a closed public allowlist
setEnvironment("invalid-key", "DATABASE_URL", "value");

// @ts-expect-error commands require an argument list, not a scalar
command("node", "--version");

// @ts-expect-error secret destinations must be strings
installUserSecret("invalid-destination", password, 123);

const invalidUnset: SequenceStepInput = {
  id: "invalid-unset",
  kind: "environment",
  operation: "unset",
  key: "AGENT_NAME",
  // @ts-expect-error unset environment steps cannot carry a value
  value: "unexpected",
};

void invalidUnset;

# `@agent-boot/definition`

This package is the trusted, host-side TypeScript definition SDK for Agent Boot.
It constructs a canonical, serializable definition graph; it does not load a
definition module, read local resource contents, resolve an operating-system
catalog entry, execute a command, or contact a provider.

> **Security warning:** a TypeScript definition and every module it imports are
> trusted executable code. Review the full dependency graph before loading it.
> Type safety and runtime validation constrain the resulting data, but they do
> not sandbox the definition program.

Local assets, prompts, scripts, and bootstrap secrets use paths relative to the
definition file. `defineAgent()` resolves those paths lexically to opaque
`file:` URL references. Validation never opens the URLs or materializes secret
contents.

`installUserSecret()` emits the transactional runner primitive: downstream
execution owns atomic installation, protected modes, verification, and bootstrap
source removal. Definitions must not add a separate secret-cleanup command.

```ts
import {
  automatic,
  command,
  curatedOperatingSystem,
  defineAgent,
  fromEnvironment,
  prompt,
  promptVariable,
  renderPrompt,
  setEnvironment,
} from "@agent-boot/definition";

const profilePrompt = prompt("install-profile", "./prompts/install-profile.md", [
  "agent-name",
]);

export default defineAgent({
  definitionUrl: import.meta.url,
  agent: { id: "my-agent", displayName: "My Agent" },
  operatingSystem: curatedOperatingSystem("raspberry-pi-os-lite-trixie-arm64", {
    architecture: "arm64",
    boards: ["raspberry-pi-5"],
  }),
  account: { username: "my-user" },
  prompts: [profilePrompt],
  steps: [
    setEnvironment("set-agent-name", "AGENT_NAME", "My Agent"),
    automatic("verify-runtime", command("node", ["--version"])),
    renderPrompt("render-profile", profilePrompt, "profile", [
      promptVariable("agent-name", fromEnvironment("AGENT_NAME")),
    ]),
  ],
});
```

The canonical schema rejects unknown fields and validates identity, Unix account
names, curated-OS compatibility selectors, environment keys, target paths,
resource references, provider/prompt ordering, and every step variant before a
downstream synthesizer receives the definition.

# Operator guide

This guide covers the supported Raspberry Pi 5 and Codex manual-auth vertical
slice. Read the [security limitations](../security.md) and
[supported matrix](../supported-matrix.md) before preparing inputs.

## 1. Prepare a trusted definition

A definition and every module it imports execute with the imaging process's
host permissions. Obtain it from a reviewed revision, inspect its complete
import graph, and keep it in a private operator directory. The target receives
the synthesized assembly, not the TypeScript source.

Copy the complete [validated public example](../../examples/definitive-agent/README.md),
including its prompt and scripts. The definition below is the exact maintained
`definition.ts`; release validation keeps this block synchronized with the
example that compiles, validates, and synthesizes in CI:

```ts
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
const prepareWorkspace = script(
  "prepare-workspace",
  "./scripts/prepare-workspace.sh",
);
const verifyBootstrap = script(
  "verify-bootstrap",
  "./scripts/verify-bootstrap.sh",
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
    automatic("prepare-workspace", command(prepareWorkspace)),
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
    automatic("verify-codex-bootstrap", command(verifyBootstrap)),
  ],
});
```

Declare every `{{variable}}` used by a prompt and bind every declared variable
in `renderPrompt()`. Synthesis fails closed before assembly or image output when
a placeholder is undeclared or a declaration is unused.

### Choose deterministic steps first

Use `automatic()` plus `command()` or a `script()` resource for package setup,
file generation, repository checkout, service installation, and verification.
Make each operation idempotent because an interrupted attempt can be retried.
Use `installUserSecret()` for protected account-home files; the runner owns its
transaction, verification, checkpoint, and bootstrap-source removal. Use
`manual()` only for a foreground console action with a silent completion probe.

Reserve `renderPrompt()` and `runProvider()` for authored cognition where Codex
judgment is useful. Do not ask a prompt to grant its own permissions, install
credentials, or replace a deterministic health check. The Codex helper installs
and verifies its exact version, writes and verifies the `agent-boot` YOLO
profile, and completes authentication before provider execution.

## 2. Create byte-exact secret files

Secret paths are resolved relative to the definition. Validation checks file
metadata but does not open secret contents; imaging reads them only after all
non-secret preparation succeeds. Keep the private definition directory mode
`0700` and secret files mode `0600`.

For scalar account and Wi-Fi values, prompt without echo and write with
`printf %s`; `echo` and here-documents usually append a newline that changes the
credential bytes:

```console
umask 077
mkdir -p ./my-agent/secrets
IFS= read -r -s -p 'Initial account password: ' account_password
printf '\n'
printf %s "$account_password" >./my-agent/secrets/account-authentication
unset account_password
IFS= read -r -s -p 'Wi-Fi passphrase: ' wifi_passphrase
printf '\n'
printf %s "$wifi_passphrase" >./my-agent/secrets/network-authentication
unset wifi_passphrase
chmod 0600 ./my-agent/secrets/*
```

Check shape without printing contents:

```console
python3 - ./my-agent/secrets/account-authentication ./my-agent/secrets/network-authentication <<'PY'
from pathlib import Path
import sys

for name in sys.argv[1:]:
    data = Path(name).read_bytes()
    if not data:
        raise SystemExit(f"{name}: empty")
    if data.endswith((b"\n", b"\r")):
        raise SystemExit(f"{name}: trailing newline")
print("secret scalar shape: ok")
PY
```

Structured credentials such as a PEM file may legitimately contain newlines;
copy their exact source bytes instead of applying the scalar check. Never put
secret values in command arguments, environment steps, prompts, logs, issues,
pull requests, or notes.

## 3. Validate and synthesize

Build the reviewed workspace, then validate the trusted definition:

```console
npm ci --ignore-scripts
npm run build
create-agent validate --definition ./my-agent/definition.ts
```

Expected success identifies the definition path, agent ID, schema version, and
metadata-check count. It does not run declared commands, resolve providers,
download an image, inspect devices, or read referenced contents.

Use release-owned OS-lock and runner files from one reviewed, compatible build:

```console
create-agent synth \
  --definition ./my-agent/definition.ts \
  --output ./assembly \
  --os-lock ./release/os-lock.json \
  --runner-runtime ./release/node \
  --runner-entrypoint ./release/runner.mjs \
  --plan
```

Remove `--plan` to publish the assembly atomically. Existing output is refused;
use `--replace` only after inspecting the destination. Identical definition,
OS-lock, runner, prompt, asset, and script bytes produce the same assembly ID.

## 4. Select and approve a stable target

List candidates without mutation:

```console
create-agent drives list
```

Select only an exact whole-disk `/dev/disk/by-id/...` alias. Treat list output
as orientation: it intentionally omits standalone serials and mount paths and
does not authorize a write. In a private operator record, independently match
the stable alias, model, serial, USB transport, removable status, byte size,
and active-system-disk ancestry. Record a maximum size only slightly above the
approved device, confirm all existing data is disposable, and obtain explicit
human approval for that exact stable target immediately before imaging.

Never substitute `/dev/sdX`, a partition path, a mounted descendant, a device
with unresolved ancestry, or the active system disk. Re-run discovery after a
device is unplugged, reinserted, or its topology changes.

## 5. Dry-run and image

Run the complete non-secret preparation path first:

```console
create-agent image \
  --definition ./my-agent/definition.ts \
  --runner-runtime ./release/node \
  --runner-entrypoint ./release/runner.mjs \
  --runner-bundle ./release/runner-bundle \
  --cache-directory ./cache \
  --lock-directory ./locks \
  --target /dev/disk/by-id/usb-example-target \
  --expect-model 'Example USB model' \
  --expect-serial 'example-private-inventory-value' \
  --expect-transport usb \
  --max-size-bytes 137438953472 \
  --dry-run
```

Dry-run does not read secret contents, download artifacts, create an image
workspace, inspect devices, or request confirmation. For the approved live run,
remove `--dry-run`. The command verifies the pinned artifact, prints a redacted
plan, requires the displayed acknowledgement phrase, locks and rechecks the
target, unmounts descendants, writes exact raw bytes, performs full read-back,
customizes the image, runs read-only FAT/ext4 checks, and cleans up. `--yes`
suppresses only the phrase; it disables no guardrail and is recommended only in
an already approved, auditable detached run.

Exit `0` with recovery state `complete` is required. Exit `9` means preparation
failed, `10` preflight or confirmation failed, `11` write/read-back failed,
`12` customization/checks failed, `13` cleanup requires operator attention,
and `130` means cancellation.

## 6. First boot and manual authentication

Physical validation requires supported Raspberry Pi 5 hardware, reliable power,
a display and keyboard for tty1/tty2, reachable Wi-Fi, the approved image,
operator access to the account password, and the ability to complete Codex
device authentication without recording the displayed code.

Boot with tty1 visible. The runner owns tty1 and displays redacted progress.
When `codex-authenticate-device` waits, complete the foreground Codex flow on
that console. Its completion probe is silent and does not read terminal input.
The provider prompt cannot start until exact-version, permission-profile, and
authentication gates succeed.

Terminal success is `runner-succeeded`. Reboot once after success and confirm
the service exits successfully without replaying the prompt, expected output
persists, and `/etc/agent-boot/bootstrap-secrets` contains no remaining source
files.

## 7. Recover safely

Use `Ctrl`+`Alt`+`F2` for the recovery login; return to tty1 with
`Ctrl`+`Alt`+`F1`. Inspect only redacted service and checkpoint metadata:

```console
sudo systemctl status agent-boot-runner.service --no-pager
sudo journalctl -u agent-boot-runner.service --no-pager
sudo test -f /var/lib/agent-boot/state.json
```

Resolve the named prerequisite or idempotency failure, then restart the service:

```console
sudo systemctl restart agent-boot-runner.service
```

Do not delete or edit `state.json`, manually remove bootstrap secrets, force a
terminal checkpoint backward, or repeat imaging against an ambiguous target.
Completed steps remain checkpointed; failed automatic steps retry only within
their bounded policy. Exit `13`, mounted descendants, or an identity mismatch
requires cleanup and fresh topology inspection before any retry.

For offline Wi-Fi recovery, follow the
[network reconfiguration guide](network-reconfiguration.md). That utility does
not rewrite runner state.

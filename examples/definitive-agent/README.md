# Validated Agent Boot definition

This is the maintained public example for the supported first Codex vertical
slice. It is host-neutral, uses fake role-based values, and compiles and
synthesizes against the current SDK in CI.

Copy this directory to a private operator workspace. Replace `<network-ssid>`
and review the exact Codex `0.144.6` pin. Create these operator-only files with
mode `0600`; do not commit them:

- `secrets/account-authentication`: the initial account password, byte-exact,
  with no trailing newline;
- `secrets/network-authentication`: the Wi-Fi passphrase, byte-exact, with no
  trailing newline; and
- `secrets/repository-credential`: an illustrative credential installed into
  the account home by the runner.

The sequence performs deterministic Codex installation, profile verification,
and manual device authentication before any authored setup. It then prepares
the workspace with an idempotent shell script, starts an illustrative support
process, transactionally installs the repository credential, renders a prompt
whose declared `agent-name` variable matches `{{agent-name}}`, runs Codex, and
uses a deterministic shell step to verify the provider result.

Use deterministic `automatic()` commands, `script()` resources,
`installUserSecret()`, and `manual()` gates for setup that should be inspectable
and retryable. Use `renderPrompt()` and `runProvider()` only when the action
benefits from authored cognition. Always follow provider work with a
deterministic verification step when success has a machine-checkable result.

The example does not execute during compilation. Validation executes the
trusted TypeScript module but does not run its declared commands or read secret
contents. Synthesis copies the scripts and prompt while retaining only opaque
secret references.

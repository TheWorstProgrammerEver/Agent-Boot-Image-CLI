# Authored post-cognition setup recipe

This representative definition proves that per-agent setup can remain an
ordered recipe. It does not require a hard-coded post-cognition phase or a
special `config.toml` primitive.

## Sequence shape

The definition deliberately places every setup action after
`codex.bootstrapSteps`. For manual device authentication, the final bootstrap
step is the successful `codex login status` gate. The authored sequence then:

1. updates normal interactive Codex autonomy defaults with an idempotent script;
2. installs git deterministically;
3. transactionally installs the GitHub App private key and identifier config;
4. checks out reviewed GitHub helper, skills, and Mind Maintainer revisions;
5. installs the askpass helpers and Codex skills;
6. installs and enables the Mind Maintainer service/timer;
7. renders a non-secret audit prompt and runs Codex;
8. deterministically verifies the prompt report and all prior setup; and
9. reaches terminal ready state only when the runner checkpoints success.

The external repository revisions are exact commits. Review and deliberately
update those pins before a future physical run.

## Primitive boundary

Use `automatic()` for deterministic, inspectable, idempotent operations with a
clear exit status: package installation, repository checkout, helper
installation, config editing, service/timer installation, and final
verification. Scripts should reject dirty or unsafe state rather than deleting
it, and should make a safe retry converge.

Use `installUserSecret()` when operator-provided bytes must become a protected
file in the account home. The runner owns transactional installation,
checkpointing, verification, and source removal. Do not pass credential bytes
through command arguments, environment steps, prompts, logs, or the assembly.

Use `manual()` for a physical-console gate whose completion can be probed
without exposing interactive output. The Codex provider slice already uses it
for device authentication, so the recipe does not add a second auth command.

Use `renderPrompt()` plus `runProvider()` only for work that benefits from
reasoning or agent-specific interpretation. In this recipe Codex audits
metadata and writes a report; it does not install packages, mutate credentials,
or own service state. A deterministic step validates the result afterward.

## Operator-only secret inputs

Create these local files beside a copied definition before synthesis or
imaging. Keep them mode `0600` and never commit them:

- `secrets/account-authentication`
- `secrets/network-authentication`
- `secrets/github-app-private-key`
- `secrets/github-app-configuration`

The GitHub configuration file is shell syntax consumed by the pinned helpers.
It needs `GITHUB_APP_ID` (or `GITHUB_CLIENT_ID`) and
`GITHUB_INSTALLATION_ID`; the key is installed separately as `app.pem`. Tokens
are minted only at runtime and are never an authored input.

## Recovery and diagnostics

Runner checkpoints prevent already-succeeded steps from replaying. An
interrupted automatic attempt is treated as ambiguous and consumes that
attempt, so every deterministic script is also authored to be idempotent. Repo
sync refuses local changes, skill installation records its completed revision,
config replacement is atomic, and the systemd installer is safe to rerun.

Failures retain the step ID, attempt, exit status or signal, and recovery
classification in mode-`0600` runner state and progress events. Command output,
arguments, prompt bytes, secret values, and private paths are excluded. Inspect
the runner service status and checkpoint before retrying; resolve dirty repo or
unsafe-file diagnostics manually instead of erasing state.

## Validation scope

`test/integration/non-destructive/post-cognition-recipe.test.mjs` synthesizes
this definition with synthetic operator inputs, materializes only a fixture
root, and executes the real runner against a fake command host. It covers every
operation class above, a failure/reboot/resume at skill installation, terminal
ordering, no replay after completion, temporary-root cleanup, and a redaction
scan for certificate/key material, tokens, device codes, generated credentials,
and private host facts. It performs no package install, network call, provider
call, privilege escalation, systemd mutation, mount, or device access.

# Public examples

Everything in this directory is maintained, visitor-facing usage material. The
definitions compile against the current TypeScript SDK and use role-based,
illustrative values only. Copy an example into a private operator directory,
replace its documented placeholders, and create the referenced secret files
there. Never add those files back to this repository.

- [`definitive-agent/`](definitive-agent/README.md) is the compact, supported
  first Codex vertical slice: account and Wi-Fi inputs, manual device auth,
  deterministic post-auth setup, transactional secret installation, prompt
  rendering, provider execution, and deterministic post-provider verification.
- [`post-cognition-agent/`](post-cognition-agent/README.md) is an extended
  authored-recipe pattern. Its repository names, revisions, credential inputs,
  and service names are illustrative and must be replaced with reviewed
  deployment values.

Internal canonical JSON, golden filesystem trees, and non-destructive harness
inputs live under `packages/*/fixtures`, `test/`, and `test-support/`. Those
files preserve protocol compatibility or test provenance and are not public
definition templates.

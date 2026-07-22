# Security model and limitations

Agent Boot narrows a destructive provisioning workflow; it does not make
untrusted definitions safe or turn removable media into a secure credential
store.

## Trust boundaries

- A TypeScript definition and every import are trusted executable code on the
  Linux imaging host. Type checking and runtime schemas validate the resulting
  declaration; they do not sandbox its evaluation.
- The target never evaluates TypeScript. It consumes a versioned, immutable
  assembly and a verified private ARM64 runtime.
- Definitions, ordinary validation, synthesis, plans, progress, checkpoints,
  and diagnostics carry secret identifiers and bounded metadata, not secret
  values.
- Provider execution occurs only after the pinned Codex binary, exact version,
  `danger-full-access` sandbox, `never` approval policy, working root, and
  authentication are verified.

## Sensitive images and media

Any image prepared with account, network, provider, or service credentials is
sensitive. Root-only file modes protect against ordinary non-root access on the
running Linux system; they do not protect against someone who possesses the
media and can read it offline. Store, transport, return, and dispose of prepared
media as credential-bearing material.

Deleting a bootstrap copy from flash is not secure erase. Flash translation,
wear levelling, caches, copies, and prior failed writes can retain data. Use
narrowly scoped, revocable credentials; minimize duplicate materialization;
rotate or revoke credentials when media is lost, returned, or no longer needed.

## Secret file contract

- Keep private operator directories mode `0700` and secret inputs mode `0600`.
- Account passwords and Wi-Fi passphrases are byte-exact scalar files. A
  trailing newline changes the value and can fail image customization. Use
  hidden input plus `printf %s`, then validate only length/newline shape without
  printing contents.
- Structured secrets retain their intended bytes. Do not normalize PEM, JSON,
  or configuration files unless their owning format requires it.
- Do not pass secrets through command-line arguments, environment steps,
  prompts, logs, issue comments, PRs, screenshots, or durable notes.
- `installUserSecret()` accepts a regular non-symlink bootstrap source, anchors
  the destination beneath the configured account home, publishes atomically,
  applies account ownership and protected modes, verifies bytes and metadata,
  removes the source durably, and records resumable transaction state.
- Definitions must not add their own secret cleanup command. Manual cleanup can
  break recovery guarantees and still cannot claim secure erasure.

## Destructive command boundary

`create-agent image` supports stable whole-disk `/dev/disk/by-id/...` targets
only. It requires exact model, serial, transport, removable status, and maximum
size expectations, blocks active-root and mounted ancestry, prints a redacted
plan, requires acknowledgement, locks the target, and rechecks identity before
write. There is no override for those checks.

The operator still owns target provenance and disposability. `drives list` is a
read-only aid, not approval. Never copy private serials or stable device IDs into
public evidence; retain the exact approval in a restricted operator record.

## Platform and provider limits

The imaging host contract is Linux only. macOS and Windows hosts are not
supported. The only advertised target is the exact Raspberry Pi OS Lite ARM64
Trixie artifact on Raspberry Pi 5. The only physically validated provider slice
is Codex `0.144.6` with manual device authentication. Other boards, OS releases,
artifacts, provider versions, automatic provider credentials, and deployment
recipes require separate validation before they can be advertised.

## Redaction limits

The product emits constant or allowlisted progress and bounded structural
diagnostics. It discards automatic and provider output from console/journal
paths and never records prompt bytes. That boundary cannot protect secrets that
a definition itself executes or imports during trusted evaluation, that an
operator prints outside the tool, or that a provider deliberately writes into
its working root. Review definitions and prompts accordingly.

The redacted physical evidence is recorded in
[RYA-146 validation](validation/rya-146-physical-image-and-first-boot.md).

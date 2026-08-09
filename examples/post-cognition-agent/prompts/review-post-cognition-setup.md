# Review {{agent-name}} post-cognition setup

Audit the deterministic setup already completed by Agent Boot. Inspect the
current boot journal and Agent Boot checkpoint metadata as well as filesystem
metadata and service status. Never read, print, copy, or summarize credential
contents, and never edit or delete an Agent Boot checkpoint.

Confirm that git is available, the GitHub App askpass helpers are executable,
the checked-out skills have been installed, and the Mind Maintainer timer is
enabled. Write a concise, non-secret report to
`post-cognition-review.md` in the configured working root.

If deterministic setup drift is present and the intended correction is local,
idempotent, non-secret, and already described by the installed recipe, repair
it and repeat the relevant check. Do not improvise a replacement daemon,
broaden permissions, rewrite credentials, or perform external effects. If a
safe correction is not established, fail and name only the missing component
and its safe recovery command. The deterministic verifier that follows remains
the authority for completion.

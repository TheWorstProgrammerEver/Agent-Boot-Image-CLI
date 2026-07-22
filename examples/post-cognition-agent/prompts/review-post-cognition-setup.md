# Review {{agent-name}} post-cognition setup

Audit the deterministic setup already completed by Agent Boot. Inspect metadata
and status only; never read, print, copy, or summarize credential contents.

Confirm that git is available, the GitHub App askpass helpers are executable,
the checked-out skills have been installed, and the Mind Maintainer timer is
enabled. Write a concise, non-secret report to
`post-cognition-review.md` in the configured working root. If a prerequisite is
missing, fail and name only the missing component and its safe recovery command.

Do not install packages, rewrite credentials, change systemd units, or alter
Codex permission settings. Those deterministic operations belong to the
ordered recipe and are verified by the step that follows this provider call.

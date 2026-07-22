#!/usr/bin/env bash
set -euo pipefail

github_revision="${1:?GitHub helper revision is required}"
skills_revision="${2:?skills revision is required}"
maintainer_revision="${3:?maintainer revision is required}"

git --version >/dev/null
for helper in codex-github-token codex-github-askpass codex-gh; do
  test -x "$HOME/.local/bin/$helper"
done
for credential in app.pem codex.env; do
  test "$(stat -c '%a' "$HOME/.config/codex-github/$credential")" = "600"
done
test "$(git -C "$HOME/workspace/codex-agent-setup-github" rev-parse HEAD)" = \
  "$github_revision"
test "$(git -C "$HOME/workspace/codex-skills" rev-parse HEAD)" = "$skills_revision"
test "$(git -C "$HOME/workspace/codex-agent-setup-mind-maintainer" rev-parse HEAD)" = \
  "$maintainer_revision"
test -f "$HOME/.codex/skills/manage-durable-notes/SKILL.md"
systemctl is-enabled --quiet codex-agent-mind-maintainer.timer
systemctl is-active --quiet codex-agent-mind-maintainer.timer
test -s "$HOME/workspace/post-cognition-review.md"

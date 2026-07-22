#!/usr/bin/env bash
set -euo pipefail

relative_source="${1:?home-relative setup repository is required}"
source_root="$HOME/$relative_source"
installer="$source_root/mind-maintainer/scripts/install-schedule.sh"

if [[ ! -x "$installer" ]]; then
  printf 'Pinned setup source does not contain an executable Mind Maintainer installer.\n' >&2
  exit 1
fi

sudo -n env \
  TARGET_USER="$(id -un)" \
  MAINTAINER_DIR="$source_root/mind-maintainer" \
  "$installer"
systemctl is-enabled --quiet codex-agent-mind-maintainer.timer
systemctl is-active --quiet codex-agent-mind-maintainer.timer

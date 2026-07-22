#!/usr/bin/env bash
set -euo pipefail

relative_source="${1:?home-relative setup repository is required}"
source_root="$HOME/$relative_source"
config_dir="$HOME/.config/codex-github"

for credential in "$config_dir/app.pem" "$config_dir/codex.env"; do
  if [[ ! -f "$credential" || -L "$credential" ]]; then
    printf 'Missing or unsafe GitHub App credential file.\n' >&2
    exit 1
  fi
  if [[ "$(stat -c '%a' "$credential")" != "600" ]]; then
    printf 'GitHub App credential file must have mode 0600.\n' >&2
    exit 1
  fi
done
if ! grep -Eq '^(GITHUB_CLIENT_ID|GITHUB_APP_ID)=' "$config_dir/codex.env" ||
  ! grep -Eq '^GITHUB_INSTALLATION_ID=' "$config_dir/codex.env"; then
  printf 'GitHub App configuration is missing required identifier fields.\n' >&2
  exit 1
fi

CODEX_GITHUB_HELPER_INSTALL_DIR="$HOME/.local/bin" \
  "$source_root/github/install-github-app-helpers.sh"
for helper in codex-github-token codex-github-askpass codex-gh; do
  test -x "$HOME/.local/bin/$helper"
done

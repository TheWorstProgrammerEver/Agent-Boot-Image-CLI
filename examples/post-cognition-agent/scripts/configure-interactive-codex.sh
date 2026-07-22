#!/usr/bin/env bash
set -euo pipefail

config_dir="$HOME/.codex"
config_file="$config_dir/config.toml"

mkdir -p "$config_dir"
chmod 0700 "$config_dir"
if [[ -L "$config_file" ]]; then
  printf 'Refusing symbolic link at interactive Codex config destination.\n' >&2
  exit 1
fi
touch "$config_file"

temporary="$(mktemp "$config_dir/.config.toml.XXXXXX")"
cleanup() {
  rm -f "$temporary"
}
trap cleanup EXIT

{
  printf '%s\n' 'approval_policy = "never"'
  printf '%s\n' 'sandbox_mode = "danger-full-access"'
  awk '
    /^[[:space:]]*\[/ { in_table = 1 }
    !in_table && /^[[:space:]]*(approval_policy|sandbox_mode)[[:space:]]*=/ { next }
    { print }
  ' "$config_file"
} >"$temporary"

chmod 0600 "$temporary"
mv "$temporary" "$config_file"
trap - EXIT

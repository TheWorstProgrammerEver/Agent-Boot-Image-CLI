#!/usr/bin/env bash
set -euo pipefail

workspace="$HOME/workspace"
mkdir -p "$workspace"
chmod 0700 "$workspace"

temporary="$(mktemp "$workspace/.agent-boot-prepared.XXXXXX")"
cleanup() {
  rm -f "$temporary"
}
trap cleanup EXIT
printf '%s\n' 'prepared' >"$temporary"
chmod 0600 "$temporary"
mv "$temporary" "$workspace/.agent-boot-prepared"
trap - EXIT

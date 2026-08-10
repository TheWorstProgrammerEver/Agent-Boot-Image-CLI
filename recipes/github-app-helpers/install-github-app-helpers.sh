#!/usr/bin/env bash
set -euo pipefail

script_dir="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
install_dir="${CODEX_GITHUB_HELPER_INSTALL_DIR:-$HOME/.local/bin}"

usage() {
  cat <<'EOF'
Usage: ./recipes/github-app-helpers/install-github-app-helpers.sh [--dry-run]

Installs GitHub App helper scripts into $HOME/.local/bin by default.

Environment overrides:
  CODEX_GITHUB_HELPER_INSTALL_DIR  Destination directory.
EOF
}

dry_run=0
while (($#)); do
  case "$1" in
    --dry-run)
      dry_run=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      printf 'Unknown option: %s\n\n' "$1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

helpers=(
  codex-github-token
  codex-github-askpass
  codex-gh
)

if [[ "$dry_run" == "1" ]]; then
  printf 'DRY would create %s\n' "$install_dir"
  for helper in "${helpers[@]}"; do
    printf 'DRY would install %s to %s/%s\n' "$script_dir/$helper" "$install_dir" "$helper"
  done
  exit 0
fi

install -d -m 0755 "$install_dir"
for helper in "${helpers[@]}"; do
  install -m 0755 "$script_dir/$helper" "$install_dir/$helper"
done

#!/usr/bin/env bash
set -euo pipefail

repository_url="${1:?repository URL is required}"
revision="${2:?exact revision is required}"
relative_destination="${3:?home-relative destination is required}"

if [[ ! "$revision" =~ ^[0-9a-f]{40}$ ]]; then
  printf 'Repository revision must be an exact 40-character commit.\n' >&2
  exit 2
fi
case "$relative_destination" in
  ""|/*|..|../*|*/../*|*/..)
    printf 'Repository destination must stay beneath the account home.\n' >&2
    exit 2
    ;;
esac

destination="$HOME/$relative_destination"
mkdir -p "$(dirname "$destination")"

if [[ -e "$destination" && ! -d "$destination/.git" ]]; then
  printf 'Repository destination exists but is not a git checkout.\n' >&2
  exit 1
fi
if [[ ! -d "$destination/.git" ]]; then
  git clone --filter=blob:none --no-checkout "$repository_url" "$destination"
fi
if [[ -n "$(git -C "$destination" status --porcelain)" ]]; then
  printf 'Repository checkout has local changes; inspect before retrying.\n' >&2
  exit 1
fi

git -C "$destination" fetch --depth=1 origin "$revision"
if [[ "$(git -C "$destination" rev-parse FETCH_HEAD)" != "$revision" ]]; then
  printf 'Fetched repository revision did not match the authored pin.\n' >&2
  exit 1
fi
git -C "$destination" checkout --detach --force "$revision"
git -C "$destination" rev-parse --verify HEAD >/dev/null

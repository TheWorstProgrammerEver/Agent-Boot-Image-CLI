#!/usr/bin/env bash
set -euo pipefail

relative_source="${1:?home-relative skills repository is required}"
source_root="$HOME/$relative_source"
state_dir="$HOME/.local/state/agent-boot/post-cognition"
marker="$state_dir/codex-skills-revision"
revision="$(git -C "$source_root" rev-parse --verify HEAD)"

all_installed=1
skill_count=0
while IFS= read -r skill_file; do
  skill_count="$((skill_count + 1))"
  skill_name="$(basename "$(dirname "$skill_file")")"
  if [[ ! -f "$HOME/.codex/skills/$skill_name/SKILL.md" ]]; then
    all_installed=0
    break
  fi
done < <(find "$source_root" -mindepth 2 -maxdepth 2 -name SKILL.md -print)

if [[ "$skill_count" == "0" ]]; then
  printf 'Pinned skills source contains no installable skills.\n' >&2
  exit 1
fi

if [[ "$all_installed" == "1" && -f "$marker" && "$(<"$marker")" == "$revision" ]]; then
  exit 0
fi

npm --prefix "$source_root" run install:skills
mkdir -p "$state_dir"
temporary="$(mktemp "$state_dir/.codex-skills-revision.XXXXXX")"
printf '%s\n' "$revision" >"$temporary"
chmod 0600 "$temporary"
mv "$temporary" "$marker"

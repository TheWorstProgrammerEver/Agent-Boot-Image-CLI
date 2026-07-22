#!/usr/bin/env bash
set -euo pipefail

if command -v git >/dev/null 2>&1; then
  git --version >/dev/null
  exit 0
fi

export DEBIAN_FRONTEND=noninteractive
sudo -n apt-get update -y
sudo -n apt-get install -y git ca-certificates
git --version >/dev/null

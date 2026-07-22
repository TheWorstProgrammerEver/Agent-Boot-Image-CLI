#!/usr/bin/env bash
set -euo pipefail

test "$(<"$HOME/workspace/.agent-boot-prepared")" = "prepared"
test "$(<"$HOME/workspace/bootstrap-report.txt")" = "agent bootstrap verified"
test -f "$HOME/.config/repository/credential"
test ! -L "$HOME/.config/repository/credential"
test "$(stat -c '%a' "$HOME/.config/repository/credential")" = "600"
